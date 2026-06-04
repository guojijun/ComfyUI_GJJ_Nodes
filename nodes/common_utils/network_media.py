from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

import folder_paths


IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "avif", "tiff"}
AUDIO_EXTS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "aiff", "aif"}
VIDEO_EXTS = {"mp4", "mov", "mkv", "webm", "avi", "flv", "mpeg", "mpg", "m4v", "wmv"}
MEDIA_COPY_SUBDIR = "GJJ_TemplateParams"
MEDIA_DOWNLOAD_TIMEOUT = 45
DEFAULT_DOWNLOAD_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36"
)
DEFAULT_MEDIA_EXT = {
    "IMAGE": ".png",
    "AUDIO": ".wav",
    "VIDEO": ".mp4",
}
MEDIA_ACCEPT_HEADER = {
    "IMAGE": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "AUDIO": "audio/*,*/*;q=0.8",
    "VIDEO": "video/*,*/*;q=0.8",
}


def gjjutils_detect_media_type(value: Any) -> str | None:
    if not isinstance(value, str):
        return None

    text = value.strip()
    if "." not in text:
        return None

    parsed = urlparse(text)
    path_text = unquote(parsed.path or text).strip().lower()
    if parsed.path.endswith("/view") and parsed.query:
        query = parse_qs(parsed.query)
        query_name = query.get("filename", [""])[0]
        if query_name:
            path_text = unquote(query_name).strip().lower()
    ext = Path(path_text).suffix.lower().lstrip(".")
    if not ext and "." in path_text:
        ext = path_text.rsplit(".", 1)[-1]

    if ext in IMAGE_EXTS:
        return "IMAGE"
    if ext in AUDIO_EXTS:
        return "AUDIO"
    if ext in VIDEO_EXTS:
        return "VIDEO"
    return None


def gjjutils_is_network_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def gjjutils_safe_media_basename(name: str, media_type: str | None = None) -> str:
    raw_name = unquote(str(name or "")).replace("\\", "/").rsplit("/", 1)[-1]
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw_name).strip(" ._")
    if not safe_name:
        safe_name = "downloaded_media"
    suffix = Path(safe_name).suffix
    if not suffix and media_type in DEFAULT_MEDIA_EXT:
        safe_name = f"{safe_name}{DEFAULT_MEDIA_EXT[media_type]}"
    return safe_name


def gjjutils_url_media_basename(url: str, media_type: str | None = None) -> str:
    parsed = urlparse(str(url or "").strip())
    name = Path(unquote(parsed.path or "")).name
    if not name:
        digest = hashlib.sha1(str(url).encode("utf-8", "ignore")).hexdigest()[:10]
        name = f"network_media_{digest}"
    return gjjutils_safe_media_basename(name, media_type)


def gjjutils_safe_media_subdir_part(name: str) -> str:
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f\s]+', "_", unquote(str(name or ""))).strip(" ._")
    return (safe_name or "network")[:72].strip(" ._") or "network"


def gjjutils_url_media_source_subdir(url: str) -> str:
    parsed = urlparse(str(url or "").strip())
    path_parts = [part for part in unquote(parsed.path or "").replace("\\", "/").split("/") if part]
    source_name = path_parts[-2] if len(path_parts) >= 2 else (parsed.netloc or "network")
    source_dir = "/".join(path_parts[:-1])
    source_key = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}/{source_dir}"
    if parsed.query:
        source_key = f"{source_key}?{parsed.query}"
    digest = hashlib.sha1(source_key.encode("utf-8", "ignore")).hexdigest()[:10]
    return f"{gjjutils_safe_media_subdir_part(source_name)}_{digest}"


def gjjutils_url_media_relative_path(
    url: str,
    media_type: str | None = None,
    copy_subdir: str = MEDIA_COPY_SUBDIR,
) -> Path:
    subdir = gjjutils_safe_media_subdir_part(copy_subdir) if copy_subdir != MEDIA_COPY_SUBDIR else MEDIA_COPY_SUBDIR
    return Path(subdir) / gjjutils_url_media_source_subdir(url) / gjjutils_url_media_basename(url, media_type)


def gjjutils_find_input_media_by_relative_path(relative_path: str | os.PathLike[str]) -> str | None:
    parts = [part for part in Path(relative_path).parts if part not in {"", ".", ".."}]
    if not parts:
        return None

    try:
        input_root = Path(folder_paths.get_input_directory())
    except Exception:
        return None

    direct = input_root.joinpath(*parts)
    if direct.is_file():
        return str(direct)
    return None


def _network_media_headers(url: str, media_type: str, user_agent: str) -> dict[str, str]:
    parsed = urlparse(str(url or "").strip())
    origin = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else ""
    return {
        "User-Agent": user_agent,
        "Accept": MEDIA_ACCEPT_HEADER.get(media_type, "*/*"),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": origin,
    }


def _download_with_urllib(url: str, tmp: Path, headers: dict[str, str], timeout: int) -> None:
    request = Request(url, headers=headers)
    with urlopen(request, timeout=max(1, int(timeout))) as response:
        status = int(getattr(response, "status", 200) or 200)
        if status >= 400:
            raise RuntimeError(f"HTTP {status}")
        with open(tmp, "wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)


def _download_with_curl(url: str, tmp: Path, headers: dict[str, str], timeout: int) -> None:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("未找到 curl.exe")
    cmd = [
        curl,
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        str(max(1, min(30, int(timeout)))),
        "--max-time",
        str(max(1, int(timeout))),
        "--retry",
        "2",
        "--retry-delay",
        "1",
        "--output",
        str(tmp),
    ]
    for key, value in headers.items():
        if value:
            cmd.extend(["--header", f"{key}: {value}"])
    cmd.append(url)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=max(5, int(timeout) + 10))
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"curl 失败：{detail or result.returncode}")


def gjjutils_download_network_media_to_input(
    url: str,
    media_type: str,
    *,
    copy_subdir: str = MEDIA_COPY_SUBDIR,
    timeout: int = MEDIA_DOWNLOAD_TIMEOUT,
    user_agent: str = DEFAULT_DOWNLOAD_USER_AGENT,
) -> str:
    media_type = str(media_type or "").upper()
    if not gjjutils_is_network_url(url):
        raise ValueError("只支持 http/https 网络媒体地址。")
    if media_type not in DEFAULT_MEDIA_EXT:
        raise ValueError("无法识别媒体类型。")

    relative_path = gjjutils_url_media_relative_path(url, media_type, copy_subdir=copy_subdir)
    existing = gjjutils_find_input_media_by_relative_path(relative_path)
    if existing:
        return existing

    input_root = Path(folder_paths.get_input_directory())
    dest = input_root / relative_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.download")

    headers = _network_media_headers(url, media_type, user_agent)
    errors: list[str] = []

    try:
        try:
            _download_with_urllib(url, tmp, headers, timeout)
        except Exception as exc:
            errors.append(f"urllib：{exc}")
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
            _download_with_curl(url, tmp, headers, timeout)
        if not tmp.exists() or tmp.stat().st_size <= 0:
            raise RuntimeError("下载结果为空")
        os.replace(tmp, dest)
    except Exception as exc:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        detail = "; ".join(errors)
        if detail:
            raise RuntimeError(f"{detail}; 兜底下载：{exc}") from exc
        raise

    return str(dest)


def gjjutils_input_relative_media_path(file_path: str) -> str:
    try:
        input_root = Path(folder_paths.get_input_directory()).resolve()
        path = Path(file_path).resolve()
        return path.relative_to(input_root).as_posix()
    except Exception:
        return Path(file_path).name
