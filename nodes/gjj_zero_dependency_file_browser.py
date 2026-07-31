from __future__ import annotations

import fnmatch
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from .common_utils.temp_files import (
    gjjutils_read_temp_bytes,
    gjjutils_temp_path,
    gjjutils_write_temp_file,
    gjjutils_write_temp_pil_image,
)


NODE_NAME = "GJJ_ZeroDependencyFileBrowser"
LIST_API = "/gjj/zero_dependency_file_browser/list"
OPEN_DIR_API = "/gjj/zero_dependency_file_browser/open_dir"
PICK_DIR_API = "/gjj/zero_dependency_file_browser/pick_dir"
THUMBNAIL_API = "/gjj/zero_dependency_file_browser/thumbnail"
MAX_SCAN_RESULTS = 5000
THUMBNAIL_SIZE = 96

DEFAULT_STATE = {
    "auto_execute": True,
    "recursive": False,
    "recursive_depth": 0,
    "show_hidden": False,
    "output_full_path": False,
}

SORT_MODES = [
    "名称 A-Z",
    "名称 Z-A",
    "修改时间 新-旧",
    "修改时间 旧-新",
    "大小 大-小",
    "大小 小-大",
    "路径 A-Z",
    "路径 Z-A",
    "类型 A-Z",
    "类型 Z-A",
]

FILTER_MODES = [
    "包含",
    "通配符",
    "正则",
]

OUTPUT_MODES = [
    "绝对路径",
    "相对路径",
    "文件名",
]

FILE_OUTPUT_MODES = [
    "按文件类型",
    "路径文本",
]

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".opus"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".flv", ".mpeg", ".mpg"}
TEXT_EXTENSIONS = {".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".md", ".html", ".htm", ".xml", ".ini", ".log", ".py", ".js", ".css"}
THUMBNAIL_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


class AnyType(str):
    """ComfyUI wildcard type; lets one socket carry IMAGE/AUDIO/VIDEO/STRING-like values."""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _hidden_options(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result["hidden"] = True
    result["display"] = "hidden"
    return result


def _choice(value: Any, choices: list[str], fallback: str) -> str:
    text = str(value or "").strip()
    return text if text in choices else fallback


def _as_bool(value: Any, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"false", "0", "off", "no", "关", "关闭", "否"}:
            return False
        if lowered in {"true", "1", "on", "yes", "开", "开启", "是"}:
            return True
    return bool(value)


def _parse_state(raw_value: Any) -> dict[str, Any]:
    state = dict(DEFAULT_STATE)
    try:
        parsed = json.loads(str(raw_value or "{}"))
    except Exception:
        parsed = {}
    if isinstance(parsed, dict):
        for key, fallback in DEFAULT_STATE.items():
            if key == "recursive_depth":
                try:
                    state[key] = max(0, min(3, int(parsed.get(key) or 0)))
                except Exception:
                    state[key] = 3 if _as_bool(parsed.get("recursive"), False) else 0
            else:
                state[key] = _as_bool(parsed.get(key), fallback)
        if not state["recursive_depth"] and _as_bool(parsed.get("recursive"), False):
            state["recursive_depth"] = 3
        state["recursive"] = state["recursive_depth"] > 0
    return state


def _normalize_directory(directory: str) -> str:
    raw = str(directory or "").strip().strip('"')
    if not raw:
        raise ValueError("请填写要浏览的目录路径。")
    expanded = os.path.expanduser(os.path.expandvars(raw))
    if re.fullmatch(r"[A-Za-z]:", expanded):
        expanded += "\\"
    path = os.path.abspath(os.path.normpath(expanded))
    if not os.path.isdir(path):
        raise NotADirectoryError(f"目录不存在：{path}")
    return path


def _parent_directory(path: str) -> str:
    normalized = os.path.abspath(os.path.normpath(str(path or "")))
    drive, tail = os.path.splitdrive(normalized)
    if drive and tail in {"\\", "/"}:
        return ""
    parent = os.path.dirname(normalized.rstrip("\\/"))
    if not parent or parent == normalized:
        return ""
    return parent


def _safe_relative_path(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except Exception:
        return os.path.basename(path)


def _extension_set(extensions: str) -> set[str]:
    result: set[str] = set()
    for part in re.split(r"[,，;\s]+", str(extensions or "")):
        item = part.strip().lower()
        if not item:
            continue
        if not item.startswith("."):
            item = "." + item
        result.add(item)
    return result


def _is_hidden(path: str, root: str) -> bool:
    try:
        rel_parts = Path(os.path.relpath(path, root)).parts
    except Exception:
        rel_parts = Path(path).parts
    return any(str(part).startswith(".") for part in rel_parts if part not in {".", ".."})


def _matches_filter(path: str, root: str, filter_text: str, filter_mode: str, extensions: set[str]) -> bool:
    name = os.path.basename(path)
    rel = _safe_relative_path(path, root)
    if extensions and os.path.splitext(name)[1].lower() not in extensions:
        return False

    query = str(filter_text or "").strip()
    if not query:
        return True

    haystack = f"{rel}\n{name}"
    mode = str(filter_mode or FILTER_MODES[0])
    if mode == "通配符":
        patterns = [item.strip() for item in re.split(r"[,，;\n]+", query) if item.strip()]
        return any(fnmatch.fnmatch(name.lower(), pattern.lower()) or fnmatch.fnmatch(rel.lower(), pattern.lower()) for pattern in patterns)
    if mode == "正则":
        try:
            return re.search(query, haystack, re.IGNORECASE) is not None
        except re.error as exc:
            raise ValueError(f"正则表达式无效：{exc}") from exc
    return query.lower() in haystack.lower()


def _scan_files(
    directory: str,
    filter_text: str = "",
    filter_mode: str = "包含",
    extensions: str = "",
    sort_mode: str = "名称 A-Z",
    recursive: bool = False,
    max_depth: int = 0,
    show_hidden: bool = False,
    limit: int = MAX_SCAN_RESULTS,
) -> list[dict[str, Any]]:
    root = _normalize_directory(directory)
    filter_mode = _choice(filter_mode, FILTER_MODES, FILTER_MODES[0])
    sort_mode = _choice(sort_mode, SORT_MODES, SORT_MODES[0])
    ext_set = _extension_set(extensions)
    items: list[dict[str, Any]] = []

    if recursive:
        max_depth = max(1, min(3, int(max_depth or 1)))
        walker = os.walk(root)
        for current, dirs, files in walker:
            try:
                depth = 0 if os.path.abspath(current) == root else len(Path(os.path.relpath(current, root)).parts)
            except Exception:
                depth = max_depth
            if depth >= max_depth:
                dirs[:] = []
            if not show_hidden:
                dirs[:] = [item for item in dirs if not _is_hidden(os.path.join(current, item), root)]
            for name in files:
                path = os.path.join(current, name)
                if not show_hidden and _is_hidden(path, root):
                    continue
                if not _matches_filter(path, root, filter_text, filter_mode, ext_set):
                    continue
                items.append(_file_item(path, root))
                if len(items) >= limit:
                    break
            if len(items) >= limit:
                break
    else:
        with os.scandir(root) as entries:
            for entry in entries:
                if not entry.is_file(follow_symlinks=False):
                    continue
                path = entry.path
                if not show_hidden and _is_hidden(path, root):
                    continue
                if not _matches_filter(path, root, filter_text, filter_mode, ext_set):
                    continue
                items.append(_file_item(path, root, entry))
                if len(items) >= limit:
                    break

    reverse = sort_mode in {"名称 Z-A", "修改时间 新-旧", "大小 大-小", "路径 Z-A", "类型 Z-A"}
    if sort_mode.startswith("修改时间"):
        key = lambda item: (float(item.get("mtime") or 0), item.get("name", "").lower())
    elif sort_mode.startswith("大小"):
        key = lambda item: (int(item.get("size") or 0), item.get("name", "").lower())
    elif sort_mode.startswith("路径"):
        key = lambda item: str(item.get("relative_path") or "").lower()
    elif sort_mode.startswith("类型"):
        key = lambda item: (os.path.splitext(str(item.get("name") or ""))[1].lower(), str(item.get("name") or "").lower())
    else:
        key = lambda item: str(item.get("name") or "").lower()
    items.sort(key=key, reverse=reverse)
    return items


def _file_item(path: str, root: str, entry: os.DirEntry | None = None) -> dict[str, Any]:
    stat = entry.stat(follow_symlinks=False) if entry is not None else os.stat(path)
    rel = _safe_relative_path(path, root)
    return {
        "name": os.path.basename(path),
        "path": os.path.abspath(path),
        "relative_path": rel,
        "size": int(stat.st_size),
        "mtime": float(stat.st_mtime),
    }


def _directory_item(path: str, root: str, entry: os.DirEntry | None = None) -> dict[str, Any]:
    stat = entry.stat(follow_symlinks=False) if entry is not None else os.stat(path)
    rel = _safe_relative_path(path, root)
    return {
        "name": os.path.basename(path),
        "path": os.path.abspath(path),
        "relative_path": "" if rel == "." else rel,
        "mtime": float(stat.st_mtime),
    }


def _list_child_directories(directory: str, show_hidden: bool = False) -> list[dict[str, Any]]:
    root = _normalize_directory(directory)
    dirs: list[dict[str, Any]] = []
    with os.scandir(root) as entries:
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            path = entry.path
            if not show_hidden and _is_hidden(path, root):
                continue
            dirs.append(_directory_item(path, root, entry))
    dirs.sort(key=lambda item: str(item.get("name") or "").lower())
    return dirs


def _format_output(item: dict[str, Any], output_mode: str) -> str:
    output_mode = _choice(output_mode, OUTPUT_MODES, OUTPUT_MODES[0])
    if output_mode == "文件名":
        return str(item.get("name") or "")
    if output_mode == "相对路径":
        return str(item.get("relative_path") or "")
    return str(item.get("path") or "")


def _file_kind(path: str) -> str:
    suffix = os.path.splitext(str(path or ""))[1].lower()
    if suffix in IMAGE_EXTENSIONS:
        return "IMAGE"
    if suffix in AUDIO_EXTENSIONS:
        return "AUDIO"
    if suffix in VIDEO_EXTENSIONS:
        return "VIDEO"
    if suffix in TEXT_EXTENSIONS:
        return "STRING"
    return "PATH"


def _load_image_file(path: str):
    try:
        import numpy as np
        import torch
        from PIL import Image, ImageOps, ImageSequence
    except Exception as exc:
        raise RuntimeError(f"加载图片需要 ComfyUI 自带的 Pillow/numpy/torch：{exc}") from exc

    frames = []
    target_size = None
    with Image.open(path) as image:
        for frame in ImageSequence.Iterator(image):
            current = ImageOps.exif_transpose(frame).convert("RGB")
            if target_size is None:
                target_size = current.size
            elif current.size != target_size:
                current = current.resize(target_size)
            array = np.asarray(current).astype(np.float32) / 255.0
            frames.append(torch.from_numpy(array))
            if len(frames) >= 256:
                break
    if not frames:
        raise RuntimeError("图片没有可读取的帧。")
    return torch.stack(frames, dim=0).contiguous()


def _load_audio_file(path: str) -> dict[str, Any]:
    import torch

    decode_path = _audio_decode_path(path)
    try:
        import numpy as np
        import soundfile as sf

        data, sample_rate = sf.read(decode_path, dtype="float32", always_2d=True)
        waveform = torch.from_numpy(np.asarray(data.T, dtype=np.float32, order="C")).unsqueeze(0)
        return {"waveform": waveform.contiguous(), "sample_rate": int(sample_rate)}
    except Exception as sf_exc:
        try:
            return _load_audio_file_av(decode_path)
        except Exception as av_exc:
            raise RuntimeError(f"加载音频失败：{path}；soundfile={sf_exc}；av={av_exc}") from av_exc
    finally:
        _cleanup_audio_decode_path(decode_path, path)


def _audio_decode_path(path: str) -> str:
    raw = os.path.abspath(os.path.normpath(str(path or "")))
    try:
        raw.encode("ascii")
        if len(raw) < 180:
            return raw
    except UnicodeEncodeError:
        pass
    suffix = os.path.splitext(raw)[1] or ".audio"
    info = gjjutils_write_temp_file(raw, suffix=suffix)
    return str(gjjutils_temp_path(str(info.get("filename") or "")))


def _cleanup_audio_decode_path(decode_path: str, original_path: str) -> None:
    # temp_files.py keeps content-addressed cache files for reuse.
    return


def _load_audio_file_av(path: str) -> dict[str, Any]:
    import numpy as np
    import torch
    import av

    chunks: list[np.ndarray] = []
    sample_rate = 0
    with av.open(path) as container:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise RuntimeError("没有找到音频流。")
        for frame in container.decode(stream):
            array = frame.to_ndarray()
            if array.ndim == 1:
                array = array.reshape(1, -1)
            if np.issubdtype(array.dtype, np.integer):
                info = np.iinfo(array.dtype)
                array = array.astype(np.float32) / max(abs(info.min), info.max)
            else:
                array = array.astype(np.float32, copy=False)
            chunks.append(array)
            sample_rate = int(frame.sample_rate or stream.rate or sample_rate or 0)
    if not chunks or sample_rate <= 0:
        raise RuntimeError("音频流为空。")
    data = np.concatenate(chunks, axis=1)
    data = data.astype(np.float32, copy=False)
    return {"waveform": torch.from_numpy(np.ascontiguousarray(data)).unsqueeze(0), "sample_rate": sample_rate}


def _load_video_file(path: str):
    try:
        from comfy_api.latest import InputImpl

        return InputImpl.VideoFromFile(path)
    except Exception:
        return {"path": os.path.abspath(path), "filename": os.path.basename(path), "type": "video"}


def _read_text_file(path: str) -> str:
    raw = Path(path).read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _thumbnail_canvas(image) -> Any:
    from PIL import Image

    thumb = image.convert("RGB")
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    thumb.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE), resample)
    canvas = Image.new("RGB", (THUMBNAIL_SIZE, THUMBNAIL_SIZE), (19, 33, 38))
    x = (THUMBNAIL_SIZE - thumb.width) // 2
    y = (THUMBNAIL_SIZE - thumb.height) // 2
    canvas.paste(thumb, (x, y))
    return canvas


def _thumbnail_bytes_from_image(image) -> tuple[bytes, str]:
    info = gjjutils_write_temp_pil_image(
        _thumbnail_canvas(image),
        format="PNG",
        suffix=".png",
        media_type="thumbnail",
    )
    return gjjutils_read_temp_bytes(info), "image/png"


def _video_first_frame(path: str):
    try:
        import av
        with av.open(path) as container:
            stream = next((item for item in container.streams if item.type == "video"), None)
            if stream is None:
                raise RuntimeError("没有找到视频流。")
            for frame in container.decode(stream):
                return frame.to_image()
    except Exception as av_exc:
        try:
            import imageio.v3 as iio
            from PIL import Image

            frame = iio.imread(path, index=0)
            return Image.fromarray(frame)
        except Exception as imageio_exc:
            raise RuntimeError(f"生成视频缩略图失败：av={av_exc}；imageio={imageio_exc}") from imageio_exc
    raise RuntimeError("视频没有可读取的画面帧。")


def _thumbnail_response(path: str) -> tuple[bytes, str]:
    suffix = os.path.splitext(str(path or ""))[1].lower()
    if suffix not in THUMBNAIL_EXTENSIONS:
        raise ValueError("当前文件类型不支持缩略图。")
    normalized = os.path.abspath(os.path.normpath(str(path or "")))
    if not os.path.isfile(normalized):
        raise FileNotFoundError("文件不存在。")
    if suffix in VIDEO_EXTENSIONS:
        return _thumbnail_bytes_from_image(_video_first_frame(normalized))
    try:
        from PIL import Image, ImageOps, ImageSequence
    except Exception as exc:
        raise RuntimeError(f"生成缩略图需要 Pillow：{exc}") from exc

    with Image.open(normalized) as image:
        try:
            frame = next(ImageSequence.Iterator(image))
        except Exception:
            frame = image
        thumb = ImageOps.exif_transpose(frame).convert("RGB")
        return _thumbnail_bytes_from_image(thumb)


def _load_file_output(item: dict[str, Any], output_mode: str, file_output_mode: str) -> tuple[Any, str]:
    path = str(item.get("path") or "")
    file_output_mode = _choice(file_output_mode, FILE_OUTPUT_MODES, FILE_OUTPUT_MODES[0])
    if file_output_mode == "路径文本":
        return _format_output(item, output_mode), "STRING"

    kind = _file_kind(path)
    if kind == "IMAGE":
        return _load_image_file(path), kind
    if kind == "AUDIO":
        return _load_audio_file(path), kind
    if kind == "VIDEO":
        return _load_video_file(path), kind
    if kind == "STRING":
        return _read_text_file(path), kind
    return _format_output(item, output_mode), "STRING"


def _register_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_zero_dependency_file_browser_routes_registered", False):
        return

    async def list_files(request):
        try:
            directory = request.query.get("directory", "")
            show_hidden = _as_bool(request.query.get("show_hidden"), False)
            root = _normalize_directory(directory)
            items = _scan_files(
                directory=root,
                filter_text=request.query.get("filter_text", ""),
                filter_mode=request.query.get("filter_mode", "包含"),
                extensions=request.query.get("extensions", ""),
                sort_mode=request.query.get("sort_mode", "名称 A-Z"),
                recursive=_as_bool(request.query.get("recursive"), False),
                max_depth=max(0, min(3, int(request.query.get("recursive_depth") or 0))),
                show_hidden=show_hidden,
                limit=max(1, min(MAX_SCAN_RESULTS, int(request.query.get("limit") or MAX_SCAN_RESULTS))),
            )
            dirs = [] if _as_bool(request.query.get("recursive"), False) else _list_child_directories(root, show_hidden)
            parent = _parent_directory(root)
            return web.json_response({"ok": True, "root": root, "parent": parent, "dirs": dirs, "items": items, "count": len(items)})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc), "dirs": [], "items": [], "count": 0}, status=400)

    async def open_dir(request):
        try:
            import platform
            import subprocess

            data = await request.json()
            directory = _normalize_directory(str(data.get("directory") or ""))
            system = platform.system()
            if system == "Windows":
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                subprocess.Popen(["cmd.exe", "/c", "start", "", "/max", "explorer.exe", "/n,", directory], creationflags=flags)
            elif system == "Darwin":
                subprocess.Popen(["open", directory])
            else:
                subprocess.Popen(["xdg-open", directory])
            return web.json_response({"ok": True, "directory": directory})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    async def pick_dir(request):
        try:
            import tkinter as tk
            from tkinter import filedialog

            data = await request.json()
            initial = str(data.get("directory") or "").strip()
            if initial:
                try:
                    initial = _normalize_directory(initial)
                except Exception:
                    initial = ""

            root_window = tk.Tk()
            root_window.withdraw()
            root_window.attributes("-topmost", True)
            try:
                root_window.lift()
                root_window.focus_force()
            except Exception:
                pass

            selected = filedialog.askdirectory(
                title="选择目录",
                initialdir=initial or None,
                mustexist=True,
                parent=root_window,
            )
            root_window.destroy()

            if not selected:
                return web.json_response({"ok": False, "cancelled": True, "directory": ""})
            directory = _normalize_directory(selected)
            return web.json_response({"ok": True, "directory": directory})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    async def thumbnail(request):
        try:
            raw_path = str(request.query.get("path") or "")
            body, content_type = _thumbnail_response(raw_path)
            return web.Response(
                body=body,
                content_type=content_type,
                headers={"Cache-Control": "private, max-age=86400"},
            )
        except Exception as exc:
            return web.Response(text=str(exc), status=404)

    server.routes.get(LIST_API)(list_files)
    server.routes.post(OPEN_DIR_API)(open_dir)
    server.routes.post(PICK_DIR_API)(pick_dir)
    server.routes.get(THUMBNAIL_API)(thumbnail)
    server._gjj_zero_dependency_file_browser_routes_registered = True


_register_routes()


class GJJ_ZeroDependencyFileBrowser:
    CATEGORY = "GJJ/🛠️ 工具/文件"
    FUNCTION = "next_file"
    DESCRIPTION = "零依赖目录浏览器：扫描任意本地目录，按过滤与排序结果逐个输出文件；可按文件类型输出 IMAGE/AUDIO/VIDEO/文本，也可只输出路径。"
    SEARCH_ALIASES = ["file browser", "directory browser", "folder queue", "目录浏览器", "文件队列", "零依赖"]
    RETURN_TYPES = (any_type, "STRING")
    RETURN_NAMES = ("文件", "文件完整路径")
    OUTPUT_TOOLTIPS = (
        "当前序号对应的过滤后文件；按扩展名输出 IMAGE/AUDIO/VIDEO/文本，或输出路径文本。",
        "当前序号对应文件的绝对完整路径。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "current_index": ("INT", _hidden_options({"default": 1, "min": 1, "max": 999999, "step": 1, "display_name": "当前序号", "tooltip": "1 基序号；自动队列每次执行完成后会加 1。"})),
                "directory": ("STRING", _hidden_options({"default": "", "display_name": "目录路径", "tooltip": "要浏览的本地目录，支持绝对路径、~ 和环境变量。"})),
                "filter_text": ("STRING", _hidden_options({"default": "", "display_name": "过滤文本", "tooltip": "按文件名或相对路径过滤；留空显示全部文件。"})),
                "filter_mode": ("STRING", _hidden_options({"default": "包含", "display_name": "过滤方式", "tooltip": "包含：普通文字搜索；通配符：支持 *.png；正则：使用 Python 正则。"})),
                "extensions": ("STRING", _hidden_options({"default": "", "display_name": "扩展名", "tooltip": "可选扩展名白名单，如 png,jpg,webp；留空不过滤扩展名。"})),
                "sort_mode": ("STRING", _hidden_options({"default": "名称 A-Z", "display_name": "排序", "tooltip": "过滤后的文件排序方式。"})),
                "output_mode": ("STRING", _hidden_options({"default": "绝对路径", "display_name": "输出格式", "tooltip": "一个输出口输出当前文件的绝对路径、相对路径或文件名。"})),
                "file_output_mode": ("STRING", _hidden_options({"default": "按文件类型", "display_name": "输出内容", "tooltip": "按文件类型：图片输出 IMAGE，音频输出 AUDIO，视频输出 VIDEO，文本输出内容；路径文本：只输出路径字符串。"})),
            },
            "optional": {
                "browser_state": ("STRING", _hidden_options({"default": json.dumps(DEFAULT_STATE, ensure_ascii=False), "display_name": "浏览器状态", "tooltip": "前端面板维护的 JSON 状态。"})),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return time.time()

    def next_file(
        self,
        current_index: int = 1,
        directory: str = "",
        filter_text: str = "",
        filter_mode: str = "包含",
        extensions: str = "",
        sort_mode: str = "名称 A-Z",
        output_mode: str = "绝对路径",
        file_output_mode: str = "按文件类型",
        browser_state: str = "",
    ):
        try:
            state = _parse_state(browser_state)
            items = _scan_files(
                directory=directory,
                filter_text=filter_text,
                filter_mode=filter_mode,
                extensions=extensions,
                sort_mode=sort_mode,
                recursive=state["recursive_depth"] > 0,
                max_depth=state["recursive_depth"],
                show_hidden=state["show_hidden"],
            )
            if not items:
                raise ValueError("当前过滤条件下没有可输出的文件。")
            requested = max(1, int(current_index or 1))
            effective = min(requested, len(items))
            item = items[effective - 1]
            output, output_type = _load_file_output(item, output_mode, file_output_mode)
            display_output = _format_output(item, output_mode)
            full_path = str(item.get("path") or "")
            at_end = effective >= len(items)
            status = f"已找到 {len(items)} 个文件；当前 {effective} / {len(items)}；输出 {output_type}：{display_output}"
            return {
                "ui": {
                    "preview_text": (status,),
                    "gjj_zero_dependency_file_browser": [
                        {
                            "current_index": requested,
                            "effective_index": effective,
                            "next_index": min(effective + 1, len(items)),
                            "total_files": len(items),
                            "at_end": at_end,
                            "auto_execute": bool(state["auto_execute"]),
                            "status": status,
                            "output_type": output_type,
                            "items": items[:300],
                        }
                    ],
                },
                "result": (output, full_path),
            }
        except Exception as exc:
            message = f"执行错误：{exc}"
            print(f"[GJJ 零依赖目录浏览器] {message}")
            return {
                "ui": {
                    "preview_text": (message,),
                    "gjj_zero_dependency_file_browser": [
                        {
                            "current_index": int(current_index or 1),
                            "effective_index": 0,
                            "next_index": 1,
                            "total_files": 0,
                            "at_end": False,
                            "auto_execute": False,
                            "status": message,
                            "output_type": "STRING",
                            "items": [],
                        }
                    ],
                },
                "result": ("", ""),
            }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ZeroDependencyFileBrowser}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📁 内置目录浏览器"}
