from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import folder_paths

COMMON_MEDIA_OPEN_FOLDER_API = "/gjj/common/open_media_folder"


def gjjutils_media_root(media_type: str) -> Path:
    media_type = str(media_type or "temp").strip().lower()
    if media_type == "output":
        return Path(folder_paths.get_output_directory()).resolve()
    if media_type == "input":
        return Path(folder_paths.get_input_directory()).resolve()
    return Path(folder_paths.get_temp_directory()).resolve()


def register_common_media_preview_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:
        print(f"[GJJ] 公共媒体预览接口注册失败：{exc}")
        return

    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_common_media_preview_api_registered", False):
        return

    @server.routes.post(COMMON_MEDIA_OPEN_FOLDER_API)
    async def gjj_common_open_media_folder(request):
        try:
            media_type = request.query.get("type", "temp")
            subfolder = str(request.query.get("subfolder", "") or "").strip("/\\")
            root = gjjutils_media_root(media_type)
            folder = (root / subfolder).resolve() if subfolder else root
            try:
                folder.relative_to(root)
            except ValueError:
                return web.json_response({"error": "路径越界"}, status=400)
            if not folder.exists():
                return web.json_response({"error": "目录不存在"}, status=404)
            if os.name == "nt":
                subprocess.Popen(["explorer", str(folder)])
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(folder)])
            else:
                subprocess.Popen(["xdg-open", str(folder)])
            return web.json_response({"status": "ok", "path": str(folder)})
        except Exception as error:
            return web.json_response({"error": str(error)}, status=500)

    server._gjj_common_media_preview_api_registered = True


register_common_media_preview_api()
