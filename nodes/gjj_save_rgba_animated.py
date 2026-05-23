from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import torch
from PIL import Image

import folder_paths

from .gjj_video_combine_runtime import combine_video, get_ffmpeg_path


NODE_NAME = "GJJ_SaveRGBAAnimated"
DEFAULT_FILENAME_PREFIX = "GJJ/RGBA动画"
FORMAT_OPTIONS = [
    "APNG",
    "animated webp",
    "GIF",
    "MOV(ProRes 4444)",
    "MOVRGBA(FFmpeg raw)",
    "MKV(FFV1)",
    "MKV(UtVideo)",
]
WEBP_METHODS = ["fastest", "default", "slowest"]
WEBP_METHOD_TO_INT = {"fastest": 0, "default": 4, "slowest": 6}
GIF_DITHER_METHODS = ["sierra2_4a", "sierra2", "floyd_steinberg", "bayer", "heckbert", "sierra3", "burkes", "atkinson", "none"]


def _ensure_image_batch(images: torch.Tensor, name: str) -> torch.Tensor:
    if not isinstance(images, torch.Tensor):
        raise RuntimeError(f"{name} 不是有效 IMAGE 张量：{type(images)!r}")
    value = images.detach().float().cpu().clamp(0.0, 1.0)
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4:
        raise RuntimeError(f"{name} 维度无效，应为 [B,H,W,C]，实际为 {tuple(value.shape)}")
    if int(value.shape[-1]) not in (1, 3, 4):
        raise RuntimeError(f"{name} 通道数无效：{int(value.shape[-1])}")
    if int(value.shape[0]) <= 0:
        raise RuntimeError(f"{name} 为空。")
    return value.contiguous()


def _normalize_rgb(images: torch.Tensor) -> torch.Tensor:
    channels = int(images.shape[-1])
    if channels == 3:
        return images
    if channels == 4:
        return images[..., :3].contiguous()
    return images.repeat(1, 1, 1, 3).contiguous()


def _alpha_from_image(images: torch.Tensor) -> torch.Tensor:
    if int(images.shape[-1]) == 1:
        alpha = images
    else:
        alpha = images[..., :3].mean(dim=-1, keepdim=True)
    return alpha.clamp(0.0, 1.0).contiguous()


def _repeat_batch(images: torch.Tensor, batch_size: int) -> torch.Tensor:
    if int(images.shape[0]) == batch_size:
        return images
    if int(images.shape[0]) == 1:
        return images.repeat(batch_size, 1, 1, 1).contiguous()
    raise RuntimeError("RGB 序列和 Alpha 序列批次数不一致，且都不是单帧，无法自动广播。")


def _merge_rgb_alpha(images_rgb: torch.Tensor, images_alpha: torch.Tensor) -> torch.Tensor:
    rgb = _normalize_rgb(_ensure_image_batch(images_rgb, "RGB 图像"))
    alpha = _alpha_from_image(_ensure_image_batch(images_alpha, "Alpha 图像"))

    batch_size = max(int(rgb.shape[0]), int(alpha.shape[0]))
    rgb = _repeat_batch(rgb, batch_size)
    alpha = _repeat_batch(alpha, batch_size)

    if tuple(rgb.shape[:3]) != tuple(alpha.shape[:3]):
        raise RuntimeError(
            "RGB 图像和 Alpha 图像的批次/尺寸不一致："
            f"RGB={tuple(rgb.shape)}，Alpha={tuple(alpha.shape)}"
        )
    return torch.cat([rgb, alpha], dim=-1).contiguous()


def _parse_output_files(text: str, main_path: str) -> list[str]:
    raw = str(text or "").strip()
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return [str(item) for item in data if str(item or "").strip()]
        except Exception:
            pass
    return [str(main_path)] if str(main_path or "").strip() else []


def _unique_zip_path(anchor_path: str) -> str:
    anchor = Path(anchor_path)
    parent = anchor.parent
    stem = anchor.stem or "rgba_animation"
    candidate = parent / f"{stem}_rgba_frames.zip"
    index = 1
    while candidate.exists():
        candidate = parent / f"{stem}_rgba_frames_{index:03d}.zip"
        index += 1
    return str(candidate)


def _save_rgba_zip(rgba_frames: torch.Tensor, anchor_path: str) -> str:
    if not anchor_path:
        raise RuntimeError("主输出文件路径为空，无法生成 RGBA PNG ZIP。")

    zip_path = _unique_zip_path(anchor_path)
    frames = rgba_frames.detach().cpu().clamp(0.0, 1.0)

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for index, frame in enumerate(frames, start=1):
            array = torch.round(frame * 255.0).to(torch.uint8).numpy()
            image = Image.fromarray(array, mode="RGBA")
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            archive.writestr(f"img_{index:03d}.png", buffer.getvalue())
    return zip_path


def _preview_item(path: str, save_output: bool, *, root: str | None = None, item_type: str | None = None) -> dict[str, Any] | None:
    if not path:
        return None

    root_path = Path(
        root if root is not None else (
            folder_paths.get_output_directory() if bool(save_output) else folder_paths.get_temp_directory()
        )
    ).resolve()
    resolved = Path(path).resolve()
    try:
        relative = resolved.relative_to(root_path)
        subfolder = "" if str(relative.parent) == "." else str(relative.parent).replace("\\", "/")
    except ValueError:
        subfolder = ""

    return {
        "filename": resolved.name,
        "subfolder": subfolder,
        "type": item_type or ("output" if bool(save_output) else "temp"),
    }


def _apply_standard_preview(
    ui_payload: dict[str, Any],
    output_path: str,
    format_name: str,
    save_output: bool,
    preview_item: dict[str, Any] | None = None,
) -> dict[str, Any]:
    preview = preview_item or _preview_item(output_path, save_output)
    if preview is None:
        return ui_payload

    suffix = Path(str(preview.get("filename") or output_path)).suffix.lower()
    animated_suffixes = {".gif", ".webp", ".apng", ".mov", ".mkv"}
    if suffix in animated_suffixes or str(format_name).startswith("video/"):
        ui_payload["gifs"] = [preview]
        ui_payload["animated"] = [preview]
    else:
        ui_payload["images"] = [preview]
    return ui_payload


def _unique_preview_path(filename_prefix: str, suffix: str) -> str:
    temp_root = Path(folder_paths.get_temp_directory()).resolve()
    raw = str(filename_prefix or DEFAULT_FILENAME_PREFIX).replace("\\", "/").strip(" /.")
    parts = [part for part in raw.split("/") if part and part not in {".", ".."}]
    stem = parts[-1] if parts else "RGBA动画"
    subfolder = Path(*parts[:-1]) if len(parts) > 1 else Path("GJJ")
    target_dir = (temp_root / subfolder / "gjj_rgba_preview").resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    candidate = target_dir / f"{stem}_preview{suffix}"
    index = 1
    while candidate.exists():
        candidate = target_dir / f"{stem}_preview_{index:03d}{suffix}"
        index += 1
    return str(candidate)


def _save_animated_webp_preview(
    rgba_frames: torch.Tensor,
    fps: float,
    filename_prefix: str,
) -> tuple[str, dict[str, Any] | None]:
    frames = rgba_frames.detach().cpu().clamp(0.0, 1.0)
    if int(frames.shape[0]) <= 0:
        return "", None

    preview_path = _unique_preview_path(filename_prefix, ".webp")
    pil_frames = [
        Image.fromarray(torch.round(frame * 255.0).to(torch.uint8).numpy(), mode="RGBA")
        for frame in frames
    ]
    duration_ms = max(1, round(1000.0 / max(0.01, float(fps))))
    pil_frames[0].save(
        preview_path,
        format="WEBP",
        save_all=True,
        append_images=pil_frames[1:],
        duration=duration_ms,
        loop=0,
        lossless=True,
        quality=90,
        method=4,
    )
    return (
        preview_path,
        _preview_item(
            preview_path,
            save_output=False,
            root=folder_paths.get_temp_directory(),
            item_type="temp",
        ),
    )


def _save_thumbnail_preview(
    rgba_frames: torch.Tensor,
    filename_prefix: str,
) -> tuple[str, dict[str, Any] | None]:
    frames = rgba_frames.detach().cpu().clamp(0.0, 1.0)
    if int(frames.shape[0]) <= 0:
        return "", None

    preview_path = _unique_preview_path(filename_prefix, ".png")
    array = torch.round(frames[0] * 255.0).to(torch.uint8).numpy()
    Image.fromarray(array, mode="RGBA").save(preview_path, format="PNG")
    return (
        preview_path,
        _preview_item(
            preview_path,
            save_output=False,
            root=folder_paths.get_temp_directory(),
            item_type="temp",
        ),
    )


def _resolve_format_settings(
    export_format: str,
    loop_count: int,
    webp_lossless: bool,
    webp_quality: int,
    webp_method: str,
    gif_dither: str,
    gif_alpha_threshold: int,
    gif_transparency_color: str,
) -> tuple[str, int, dict[str, Any]]:
    if export_format == "APNG":
        return "video/apng", 0, {"plays": int(loop_count)}
    if export_format == "animated webp":
        return "image/webp", int(loop_count), {
            "lossless": bool(webp_lossless),
            "quality": int(webp_quality),
            "method": int(WEBP_METHOD_TO_INT.get(webp_method, 4)),
        }
    if export_format == "GIF":
        color_text = str(gif_transparency_color or "").strip().lstrip("#") or "ffffff"
        if get_ffmpeg_path():
            return "video/ffmpeg-gif", 0, {
                "loop": int(loop_count),
                "dither": str(gif_dither or "sierra2_4a"),
                "alpha_threshold": int(gif_alpha_threshold),
                "transparency_color": color_text,
            }
        return "image/gif", int(loop_count), {}
    if export_format == "MOV(ProRes 4444)":
        return "video/ProRes", 0, {"profile": "4", "has_alpha": True}
    if export_format == "MOVRGBA(FFmpeg raw)":
        return "video/raw-rgba-mov", 0, {}
    if export_format == "MKV(FFV1)":
        return "video/ffv1-mkv", 0, {
            "pix_fmt": "rgba64le",
            "save_metadata": True,
            "trim_to_audio": False,
        }
    if export_format == "MKV(UtVideo)":
        return "video/utvideo-mkv", 0, {
            "save_metadata": True,
            "trim_to_audio": False,
        }
    raise RuntimeError(f"不支持的导出格式：{export_format}")


class GJJ_SaveRGBAAnimated:
    CATEGORY = "GJJ/图像"
    FUNCTION = "save"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "零依赖复刻 comfyui_fill-nodes 的 FLSaveRGBAAnimatedWebP："
        "输入 RGB 序列和 Alpha 序列，合成为真正的 RGBA 帧后导出 APNG、animated webp、GIF、"
        "MOV(ProRes 4444)、MOVRGBA(FFmpeg raw)、MKV(FFV1/UtVideo)。"
    )
    SEARCH_ALIASES = [
        "FLSaveRGBAAnimatedWebP",
        "RGBA animated",
        "透明动画导出",
        "RGBA导出",
        "APNG",
        "ProRes 4444",
        "FFV1",
        "UtVideo",
    ]
    RETURN_TYPES = ("VIDEO", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("视频", "主输出文件", "输出文件列表JSON", "RGBA帧ZIP")
    OUTPUT_TOOLTIPS = (
        "按当前 RGBA 帧构建的官方 VIDEO 对象，可继续接到其它视频节点。",
        "本次导出的主输出文件完整路径。",
        "本次导出的全部文件路径 JSON 数组；如果启用 ZIP，会一并包含 ZIP 路径。",
        "把每一帧保存为 PNG 后打包得到的 ZIP；关闭 ZIP 时返回空字符串。",
    )
    GJJ_HELP = {
        "title": "RGBA 动画导出",
        "description": "复刻 Fill 节点的 RGB+Alpha 动画导出方式，并扩展到 APNG、WebP、GIF、ProRes4444、Raw MOV、FFV1、UtVideo。",
        "runtime": "GIF 优先走 FFmpeg 透明调色板导出；若未找到 FFmpeg，则回退到 Pillow GIF。WebP 走 Pillow；APNG / MOV / MKV 走 GJJ 现有 FFmpeg 探测逻辑。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images_rgb": (
                    "IMAGE",
                    {
                        "display_name": "RGB 图像",
                        "tooltip": "输入 RGB 或 RGBA 图像序列；如果本身是 RGBA，会只取前 3 个颜色通道。",
                    },
                ),
                "images_alpha": (
                    "IMAGE",
                    {
                        "display_name": "Alpha 图像",
                        "tooltip": "透明度来源图像；会把前 3 个通道取平均后作为 Alpha，和源 Fill 节点保持一致。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": DEFAULT_FILENAME_PREFIX,
                        "display_name": "文件名前缀",
                        "tooltip": "保存到 output 目录下，支持子目录，例如 GJJ/RGBA动画。",
                    },
                ),
                "export_format": (
                    FORMAT_OPTIONS,
                    {
                        "default": "GIF",
                        "display_name": "导出格式",
                        "tooltip": "支持透明动画和带 Alpha 的视频封装格式。",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 16.0,
                        "min": 0.01,
                        "max": 1000.0,
                        "step": 0.01,
                        "display_name": "帧率",
                        "tooltip": "动画或视频的播放帧率。",
                    },
                ),
                "loop_count": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000,
                        "step": 1,
                        "display_name": "循环次数",
                        "tooltip": "GIF、animated webp、APNG 使用。0 表示无限循环；MOV/MKV 会忽略此参数。",
                    },
                ),
                "webp_lossless": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "WebP 无损",
                        "tooltip": "仅 animated webp 使用；开启后按无损方式导出。",
                    },
                ),
                "webp_quality": (
                    "INT",
                    {
                        "default": 100,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "WebP 质量",
                        "tooltip": "仅 animated webp 使用；数值越高，体积通常越大。",
                    },
                ),
                "webp_method": (
                    WEBP_METHODS,
                    {
                        "default": "fastest",
                        "display_name": "WebP 压缩方法",
                        "tooltip": "仅 animated webp 使用；fastest 更快，slowest 更慢但压缩更激进。",
                    },
                ),
                "gif_dither": (
                    GIF_DITHER_METHODS,
                    {
                        "default": "floyd_steinberg",
                        "display_name": "GIF 抖动算法",
                        "tooltip": "仅 GIF 使用。通常 sierra2_4a 最稳；none 体积更小但色带和锯齿更明显。",
                    },
                ),
                "gif_alpha_threshold": (
                    "INT",
                    {
                        "default": 3,
                        "min": 0,
                        "max": 255,
                        "step": 1,
                        "display_name": "GIF Alpha阈值",
                        "tooltip": "仅 GIF 使用。值越小越保留边缘，值越大边缘越干净但更容易变硬。QQ 透明表情通常 80-128 比较合适。",
                    },
                ),
                "gif_transparency_color": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "GIF 透明底色",
                        "tooltip": "仅 GIF 使用。用于透明边缘量化时的参考底色；留空时使用白色参考底色。",
                    },
                ),
                "export_rgba_zip": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "导出 RGBA 帧 ZIP",
                        "tooltip": "把每一帧额外保存为透明 PNG 并打包成 ZIP，方便后续交付或别处复用。",
                    },
                ),
                "save_output": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "保存到输出目录",
                        "tooltip": "关闭后改写到 ComfyUI 的 temp 目录。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def save(
        self,
        images_rgb: torch.Tensor,
        images_alpha: torch.Tensor,
        filename_prefix: str,
        export_format: str,
        fps: float,
        loop_count: int,
        webp_lossless: bool,
        webp_quality: int,
        webp_method: str,
        gif_dither: str,
        gif_alpha_threshold: int,
        gif_transparency_color: str,
        export_rgba_zip: bool,
        save_output: bool,
        prompt: Any = None,
        extra_pnginfo: Any = None,
        unique_id: Any = None,
    ):
        rgba_frames = _merge_rgb_alpha(images_rgb, images_alpha)
        format_name, effective_loop_count, format_overrides = _resolve_format_settings(
            export_format=export_format,
            loop_count=loop_count,
            webp_lossless=webp_lossless,
            webp_quality=webp_quality,
            webp_method=webp_method,
            gif_dither=gif_dither,
            gif_alpha_threshold=gif_alpha_threshold,
            gif_transparency_color=gif_transparency_color,
        )

        payload = combine_video(
            images=rgba_frames,
            video_inputs=None,
            frame_rate=float(fps),
            loop_count=int(effective_loop_count),
            filename_prefix=str(filename_prefix or "").strip() or DEFAULT_FILENAME_PREFIX,
            format_name=format_name,
            pingpong=False,
            save_output=bool(save_output),
            use_source_fps=False,
            audio=None,
            vae=None,
            format_overrides_json=json.dumps(format_overrides, ensure_ascii=False),
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )

        result = payload.get("result", ())
        if len(result) != 3:
            raise RuntimeError("底层视频导出返回值异常。")

        video_output, main_output_path, output_files_json = result
        output_files = _parse_output_files(output_files_json, main_output_path)
        zip_path = ""
        if bool(export_rgba_zip):
            zip_path = _save_rgba_zip(rgba_frames, str(main_output_path or ""))
            if zip_path:
                output_files.append(zip_path)

        ui_payload = dict(payload.get("ui") or {})
        preview_item = None
        thumbnail_item = None
        main_suffix = Path(str(main_output_path or "")).suffix.lower()
        if main_suffix in {".mov", ".mkv"}:
            _preview_path, preview_item = _save_animated_webp_preview(
                rgba_frames=rgba_frames,
                fps=float(fps),
                filename_prefix=str(filename_prefix or "").strip() or DEFAULT_FILENAME_PREFIX,
            )
        elif str(main_output_path or "").strip():
            preview_item = _preview_item(str(main_output_path), bool(save_output))

        _thumbnail_path, thumbnail_item = _save_thumbnail_preview(
            rgba_frames=rgba_frames,
            filename_prefix=str(filename_prefix or "").strip() or DEFAULT_FILENAME_PREFIX,
        )
        if preview_item is not None:
            ui_payload["preview_media"] = [preview_item]
            ui_payload["preview_is_video"] = (False,)
            ui_payload["preview_has_alpha"] = (True,)
        ui_payload = _apply_standard_preview(
            ui_payload=ui_payload,
            output_path=str(main_output_path or ""),
            format_name=format_name,
            save_output=bool(save_output),
            preview_item=preview_item,
        )
        if thumbnail_item is not None:
            ui_payload["images"] = [thumbnail_item]
        summary_lines = [
            f"导出格式：{export_format}",
            f"帧数：{int(rgba_frames.shape[0])}",
            f"主输出：{main_output_path or '无'}",
        ]
        if zip_path:
            summary_lines.append(f"RGBA ZIP：{zip_path}")
        ui_payload["text"] = ["\n".join(summary_lines)]

        return {
            "ui": ui_payload,
            "result": (
                video_output,
                str(main_output_path or ""),
                json.dumps(output_files, ensure_ascii=False),
                zip_path,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SaveRGBAAnimated}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 透明动画导出"}
