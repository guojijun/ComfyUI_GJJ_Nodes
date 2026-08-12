from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse, urlunparse
from urllib.request import Request, build_opener, ProxyHandler, urlopen

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
MEDIA_TYPE_EXTS = {
    "IMAGE": IMAGE_EXTS,
    "AUDIO": AUDIO_EXTS,
    "VIDEO": VIDEO_EXTS,
}
MEDIA_ACCEPT_HEADER = {
    "IMAGE": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "AUDIO": "audio/*,*/*;q=0.8",
    "VIDEO": "video/*,*/*;q=0.8",
}


def _normalize_network_media_url(url: str) -> str:
    text = str(url or "").strip()
    parsed = urlparse(text)
    if parsed.scheme.lower() not in {"http", "https"}:
        return text

    path = unquote(parsed.path or "")
    path_parts = [part for part in path.replace("\\", "/").split("/") if part]
    netloc = parsed.netloc.lower()

    if netloc == "github.com" and len(path_parts) >= 5 and path_parts[2].lower() in {"blob", "raw"}:
        owner, repo, _marker = path_parts[:3]
        rest = path_parts[3:]
        parsed = parsed._replace(
            scheme="https",
            netloc="raw.githubusercontent.com",
            path="/" + "/".join([owner, repo, *rest]),
            params="",
            query="",
            fragment="",
        )

    encoded_path = quote(unquote(parsed.path or ""), safe="/:@")
    return urlunparse(parsed._replace(path=encoded_path))


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
    suffix_ext = suffix.lower().lstrip(".")
    media_type_key = str(media_type or "").upper()
    expected_exts = MEDIA_TYPE_EXTS.get(media_type_key, set())
    if media_type_key in DEFAULT_MEDIA_EXT and (not suffix or (expected_exts and suffix_ext not in expected_exts)):
        safe_name = f"{safe_name}{DEFAULT_MEDIA_EXT[media_type_key]}"
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
    timeout_val = max(1, int(timeout))
    request = Request(url, headers=headers)
    errors: list[str] = []

    # 先尝试走默认（可能带系统代理），失败则尝试禁用代理直连
    strategies = [
        ("default", None),
        ("no_proxy", ProxyHandler({})),
    ]

    last_error: Exception | None = None
    for strategy_name, proxy_handler in strategies:
        try:
            if proxy_handler is not None:
                opener = build_opener(proxy_handler)
                context_response = opener.open(request, timeout=timeout_val)
            else:
                context_response = urlopen(request, timeout=timeout_val)
            with context_response as response:
                status = int(getattr(response, "status", 200) or 200)
                if status >= 400:
                    raise RuntimeError(f"HTTP {status}")
                with open(tmp, "wb") as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        handle.write(chunk)
                return
        except Exception as exc:
            last_error = exc
            errors.append(f"{strategy_name}：{exc}")

    detail = "; ".join(errors)
    raise RuntimeError(detail) from last_error


def _run_curl_once(curl_exe: str, base_cmd: list[str], timeout: int) -> tuple[int, str, str]:
    result = subprocess.run(base_cmd, capture_output=True, text=True, timeout=max(5, int(timeout) + 10))
    return result.returncode, (result.stderr or result.stdout or "").strip(), (result.stdout or "").strip()


def _download_with_curl(
    url: str,
    tmp: Path,
    headers: dict[str, str],
    timeout: int,
    retries: int = 2,
) -> None:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("未找到 curl.exe")

    connect_timeout = str(max(1, min(30, int(timeout))))
    max_time = str(max(1, int(timeout)))
    retries = max(0, int(retries))
    retry_args = ["--retry", str(retries), "--retry-delay", "1"] if retries > 0 else []
    header_args: list[str] = []
    for key, value in headers.items():
        if value:
            header_args.extend(["--header", f"{key}: {value}"])

    base_cmd = [
        curl,
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        connect_timeout,
        "--max-time",
        max_time,
        "--output",
        str(tmp),
        *retry_args,
        *header_args,
        url,
    ]

    # 先尝试默认（系统代理），失败则加 --noproxy 禁用代理直连
    strategies = [
        ("curl_default", base_cmd),
        ("curl_noproxy", [*base_cmd[:1], "--noproxy", "*", *base_cmd[1:]]),
    ]

    errors: list[str] = []
    for name, cmd in strategies:
        try:
            code, stderr, stdout = _run_curl_once(cmd[0], cmd, timeout)
            if code == 0:
                return
            errors.append(f"{name}：{stderr or stdout or f'退出码 {code}'}")
        except subprocess.TimeoutExpired as exc:
            errors.append(f"{name}：超时（超过 {timeout + 10} 秒）")
        except Exception as exc:
            errors.append(f"{name}：{exc}")

    raise RuntimeError(f"curl 失败：{'; '.join(errors)}")


def gjjutils_media_file_starts_like_html(path: str | os.PathLike[str]) -> bool:
    try:
        with open(Path(path), "rb") as handle:
            head = handle.read(512).lstrip().lower()
    except Exception:
        return False
    return head.startswith(b"<!doctype html") or head.startswith(b"<html")


def _validate_downloaded_media(path: str | os.PathLike[str], media_type: str) -> None:
    file_path = Path(path)
    if not file_path.is_file() or file_path.stat().st_size <= 0:
        raise RuntimeError("下载结果为空。")
    if gjjutils_media_file_starts_like_html(file_path):
        raise RuntimeError("下载结果是网页 HTML，不是媒体文件。请使用 raw 直链或 GitHub blob/raw 链接。")

    if media_type == "IMAGE":
        try:
            from PIL import Image

            with Image.open(file_path) as image:
                image.verify()
        except Exception as exc:
            raise RuntimeError(f"下载结果不是可识别的图片：{exc}") from exc


def _discard_invalid_cached_media(path: str | os.PathLike[str], media_type: str) -> bool:
    try:
        _validate_downloaded_media(path, media_type)
        return False
    except Exception as error:
        try:
            Path(path).unlink()
        except Exception:
            pass
        try:
            print(f"[GJJ] 已丢弃无效网络媒体缓存：{path} ({error})")
        except Exception:
            pass
        return True


def gjjutils_download_network_media_to_input(
    url: str,
    media_type: str,
    *,
    copy_subdir: str = MEDIA_COPY_SUBDIR,
    timeout: int = MEDIA_DOWNLOAD_TIMEOUT,
    user_agent: str = DEFAULT_DOWNLOAD_USER_AGENT,
    use_curl_fallback: bool = True,
    curl_retries: int = 2,
) -> str:
    media_type = str(media_type or "").upper()
    if not gjjutils_is_network_url(url):
        raise ValueError("只支持 http/https 网络媒体地址。")
    if media_type not in DEFAULT_MEDIA_EXT:
        raise ValueError("无法识别媒体类型。")

    url = _normalize_network_media_url(url)
    relative_path = gjjutils_url_media_relative_path(url, media_type, copy_subdir=copy_subdir)
    existing = gjjutils_find_input_media_by_relative_path(relative_path)
    if existing and not _discard_invalid_cached_media(existing, media_type):
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
            if not use_curl_fallback:
                raise
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
            _download_with_curl(url, tmp, headers, timeout, retries=curl_retries)
        _validate_downloaded_media(tmp, media_type)
        os.replace(tmp, dest)
    except Exception as exc:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        detail = "; ".join(errors)
        if detail:
            if use_curl_fallback:
                raise RuntimeError(f"{detail}; 兜底下载：{exc}") from exc
            raise RuntimeError(detail) from exc
        raise

    return str(dest)


def gjjutils_input_relative_media_path(file_path: str) -> str:
    try:
        input_root = Path(folder_paths.get_input_directory()).resolve()
        path = Path(file_path).resolve()
        return path.relative_to(input_root).as_posix()
    except Exception:
        return Path(file_path).name
