from __future__ import annotations

import base64
import io
import json
import math
import re
import time
import threading
import traceback
from copy import deepcopy
from typing import Any, Dict, Iterable, Iterator, List, Tuple

import torch
import torch.nn.functional as F
from PIL import Image, ImageColor

from nodes import MAX_RESOLUTION
from comfy.utils import common_upscale
from comfy import model_management

try:
    from server import PromptServer
except Exception:
    PromptServer = None

NODE_NAME = "GJJ_ImageResizeKJv2"

# 全局统计：ComfyUI 可能会把批量图片拆成多次单张调用。
# 因此 total / elapsed 不能只用 resize() 内部局部变量，否则每张都会清零。
_GJJ_RESIZE_RUN_STATS: Dict[str, Dict[str, Any]] = {}
_GJJ_RESIZE_RUN_LOCK = threading.RLock()
_GJJ_RESIZE_FINISH_DELAY = 0.55  # 秒：最后一张处理完后延迟汇总，等待同一轮批量调用结束



def _run_key(unique_id: Any) -> str:
    try:
        if isinstance(unique_id, (list, tuple)) and len(unique_id) == 1:
            unique_id = unique_id[0]
    except Exception:
        pass
    return str(unique_id if unique_id is not None else "global")


def _run_elapsed(stat: Dict[str, Any]) -> float:
    try:
        return max(0.0, time.time() - float(stat.get("start", time.time())))
    except Exception:
        return 0.0


def _cancel_finish_timer(stat: Dict[str, Any]) -> None:
    try:
        timer = stat.get("timer")
        if timer is not None:
            timer.cancel()
    except Exception:
        pass
    stat["timer"] = None


def _begin_run_call(unique_id: Any, input_total: int) -> Dict[str, Any]:
    """记录一次 resize() 调用开始。

    注意：这里的 input_total 可能只是 1，因为 ComfyUI 可能把批量拆成多次调用。
    所以这里做的是“累计”，不是重置。
    """
    key = _run_key(unique_id)
    now = time.time()
    with _GJJ_RESIZE_RUN_LOCK:
        stat = _GJJ_RESIZE_RUN_STATS.get(key)
        # 如果距离上次调用已经很久，认为是新一轮执行。
        if not stat or (now - float(stat.get("last_update", 0.0))) > 3.0:
            stat = {
                "key": key,
                "start": now,
                "last_update": now,
                "total": 0,
                "done": 0,
                "first_orig": None,
                "first_out": None,
                "timer": None,
                "printed_final": False,
            }
            _GJJ_RESIZE_RUN_STATS[key] = stat

        _cancel_finish_timer(stat)
        stat["last_update"] = now
        stat["total"] = int(stat.get("total", 0)) + max(1, int(input_total or 1))
        stat["printed_final"] = False
        return stat


def _finish_run_call(unique_id: Any, done_units: int, first_orig_w: int, first_orig_h: int, first_out_w: int, first_out_h: int) -> Dict[str, Any]:
    """记录一次 resize() 调用完成，并延迟发送最终汇总。"""
    key = _run_key(unique_id)
    now = time.time()
    with _GJJ_RESIZE_RUN_LOCK:
        stat = _GJJ_RESIZE_RUN_STATS.get(key)
        if not stat:
            stat = {
                "key": key,
                "start": now,
                "last_update": now,
                "total": max(1, int(done_units or 1)),
                "done": 0,
                "first_orig": None,
                "first_out": None,
                "timer": None,
                "printed_final": False,
            }
            _GJJ_RESIZE_RUN_STATS[key] = stat

        stat["done"] = int(stat.get("done", 0)) + max(1, int(done_units or 1))
        stat["total"] = max(int(stat.get("total", 0)), int(stat.get("done", 0)))
        stat["last_update"] = now
        if stat.get("first_orig") is None and first_orig_w and first_orig_h:
            stat["first_orig"] = (int(first_orig_w), int(first_orig_h))
            stat["first_out"] = (int(first_out_w), int(first_out_h))

        _cancel_finish_timer(stat)
        timer = threading.Timer(_GJJ_RESIZE_FINISH_DELAY, _finalize_run_status, args=(key,))
        timer.daemon = True
        stat["timer"] = timer
        timer.start()
        return stat


def _finalize_run_status(key: str) -> None:
    """防抖汇总：同一轮批量调用停止一小段时间后，统一输出真实总数和总耗时。"""
    with _GJJ_RESIZE_RUN_LOCK:
        stat = _GJJ_RESIZE_RUN_STATS.get(key)
        if not stat:
            return
        now = time.time()
        # 如果 timer 触发时又有新调用进来，跳过，让新的 timer 负责最终汇总。
        if (now - float(stat.get("last_update", 0.0))) < (_GJJ_RESIZE_FINISH_DELAY * 0.75):
            return

        total = int(stat.get("total", 0))
        done = int(stat.get("done", 0))
        elapsed = _run_elapsed(stat)
        first_orig = stat.get("first_orig") or (0, 0)
        first_out = stat.get("first_out") or (0, 0)
        stat["printed_final"] = True

    print(
        f"[GJJ 多功能图片缩放] 汇总完成：共处理 {done}/{total} 张，"
        f"首图 {first_orig[0]}x{first_orig[1]} -> {first_out[0]}x{first_out[1]}，"
        f"总耗时 {elapsed:.2f}s"
    )
    _send_status(
        key,
        "done",
        f"执行完成：共处理 {done}/{total} 张，耗时 {elapsed:.2f} 秒",
        progress=1.0 if total <= 0 else min(1.0, done / max(1, total)),
        total=total,
        index=done,
        elapsed=elapsed,
    )


def _send_status(unique_id: Any, state: str, message: str, progress: float | None = None, total: int | None = None, index: int | None = None, elapsed: float | None = None) -> None:
    """通过 ComfyUI websocket 给前端状态栏发真实后台状态。"""
    try:
        if PromptServer is None or not getattr(PromptServer, "instance", None):
            return
        data = {
            "node_id": str(unique_id) if unique_id is not None else "",
            "state": state,
            "message": message,
        }
        if progress is not None:
            data["progress"] = float(progress)
        if total is not None:
            data["total"] = int(total)
        if index is not None:
            data["index"] = int(index)
        if elapsed is not None:
            data["elapsed"] = float(elapsed)
        PromptServer.instance.send_sync("gjj_image_resize_kjv2_status", data)
    except Exception:
        pass


# ============================================================
# 基础工具
# ============================================================

def _to_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return int(value)
        return int(float(value))
    except Exception:
        return int(default)


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _ceil_to_multiple(value: int, multiple: Any) -> int:
    value = max(1, _to_int(value, 1))
    multiple = _to_int(multiple, 1)
    if multiple <= 1:
        return value
    return max(multiple, int(math.ceil(value / multiple)) * multiple)


def _parse_color(value: Any) -> Tuple[float, float, float]:
    """兼容 COLOR/STRING/list/tuple/dict/rgb()/rgba()，返回 0-1 RGB。"""
    try:
        if isinstance(value, dict):
            if all(k in value for k in ("r", "g", "b")):
                vals = [value.get("r", 0), value.get("g", 0), value.get("b", 0)]
                if all(0 <= _to_float(v, 0) <= 1 for v in vals):
                    return tuple(float(v) for v in vals)  # type: ignore[return-value]
                return tuple(max(0, min(255, _to_float(v, 0))) / 255.0 for v in vals)  # type: ignore[return-value]
            for key in ("hex", "color", "value"):
                if key in value:
                    return _parse_color(value[key])

        if isinstance(value, (list, tuple)) and len(value) >= 3:
            vals = [value[0], value[1], value[2]]
            if all(0 <= _to_float(v, 0) <= 1 for v in vals):
                return tuple(float(v) for v in vals)  # type: ignore[return-value]
            return tuple(max(0, min(255, _to_float(v, 0))) / 255.0 for v in vals)  # type: ignore[return-value]

        text = str(value if value is not None else "#000000").strip()
        m = re.match(r"rgba?\(([^)]+)\)", text, flags=re.I)
        if m:
            vals = [_to_float(p.strip(), 0) for p in m.group(1).split(",")[:3]]
            return tuple(max(0, min(255, v)) / 255.0 for v in vals)  # type: ignore[return-value]

        if text.startswith("#") and len(text) == 9:
            text = text[:7]

        rgb = ImageColor.getrgb(text)
        if isinstance(rgb, int):
            rgb = (rgb, rgb, rgb)
        return tuple(max(0, min(255, float(v))) / 255.0 for v in rgb[:3])  # type: ignore[return-value]
    except Exception:
        return (0.0, 0.0, 0.0)


def _method(value: Any) -> str:
    return {
        "兰索斯": "lanczos",
        "双三次": "bicubic",
        "双线性": "bilinear",
        "区域": "area",
        "最近邻": "nearest-exact",
        "lanczos": "lanczos",
        "bicubic": "bicubic",
        "bilinear": "bilinear",
        "area": "area",
        "nearest": "nearest-exact",
        "nearest-exact": "nearest-exact",
    }.get(str(value), "lanczos")


def _mode(value: Any) -> str:
    text = str(value or "等比")
    if text in ("宽高", "固定宽高", "width_height"):
        return "宽高"
    if text in ("长边", "长边适配", "long_side"):
        return "长边"
    if text in ("像素", "像素控制", "total_pixels"):
        return "像素"
    return "等比"


def _fit(value: Any) -> str:
    text = str(value or "拉伸")
    if text in ("补边", "add_border", "border", "border_pad", "pad_only"):
        return "border"
    if text in ("留边填充", "留边", "letterbox", "pad", "padding"):
        return "letterbox"
    if text in ("裁剪填满", "crop"):
        return "crop"
    return "stretch"


def _position(value: Any) -> str:
    text = str(value or "中").strip().lower()
    if text in ("上", "top", "up"):
        return "top"
    if text in ("下", "bottom", "down"):
        return "bottom"
    if text in ("左", "left"):
        return "left"
    if text in ("右", "right"):
        return "right"
    return "center"


def _axis_offset(extra: int, position: str, axis: str) -> int:
    extra = max(0, int(extra))
    if axis == "x":
        if position == "left":
            return 0
        if position == "right":
            return extra
    else:
        if position == "top":
            return 0
        if position == "bottom":
            return extra
    return extra // 2


def _aspect_ratio(aspect_ratio: Any, w: int, h: int, proportional_width: Any, proportional_height: Any) -> float:
    text = str(aspect_ratio or "原始比例")
    if text in ("原始比例", "original"):
        return max(1, w) / max(1, h)
    if text in ("自定义", "custom"):
        return max(1, _to_float(proportional_width, 1)) / max(1, _to_float(proportional_height, 1))
    if ":" in text:
        a, b = text.split(":", 1)
        return max(1, _to_float(a, 1)) / max(1, _to_float(b, 1))
    return max(1, w) / max(1, h)


def _default_config() -> Dict[str, Any]:
    return {
        "mode": "等比",
        "fit_mode": "留边填充",
        "upscale_method": "兰索斯",
        "round_to_multiple": "16",
        "pad_color": "#000000",
        "pad_feather": 0,
        "crop_position": "中",
        "device": "CPU",
        "width": 1024,
        "height": 1024,
        "border_left": 0,
        "border_top": 0,
        "border_right": 0,
        "border_bottom": 0,
        "scale_percent": 100.0,
        "long_side_length": 1024,
        "total_pixel_k": 260,
        "aspect_ratio": "1:1",
        "proportional_width": 1,
        "proportional_height": 1,
        "extra_outputs": [],
    }


def _load_config(config_json: Any) -> Dict[str, Any]:
    cfg = _default_config()
    if isinstance(config_json, dict):
        cfg.update(config_json)
        return cfg
    try:
        text = str(config_json or "").strip()
        if text:
            data = json.loads(text)
            if isinstance(data, dict):
                cfg.update(data)
    except Exception:
        pass
    return cfg



def _unwrap_list_param(value: Any) -> Any:
    """ComfyUI 在 INPUT_IS_LIST=True 时，会把普通参数/hidden 参数也包成 list。

    这里只用于 config_json、unique_id 这类标量参数：
    - ["xxx"] -> "xxx"
    - [["xxx"]] -> "xxx"
    图片和遮罩批量数据不要用这个函数解包。
    """
    try:
        while isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
    except Exception:
        pass
    return value


def _is_image_tensor(obj: Any) -> bool:
    return isinstance(obj, torch.Tensor) and obj.ndim in (3, 4) and obj.shape[-1] in (1, 3, 4)


def _is_mask_tensor(obj: Any) -> bool:
    return isinstance(obj, torch.Tensor) and obj.ndim in (2, 3)


def _image_unit_count(t: Any) -> int:
    """只用于统计真实图片数量。"""
    try:
        if isinstance(t, torch.Tensor):
            if t.ndim == 4 and t.shape[-1] in (1, 3, 4):
                return int(t.shape[0])
            if t.ndim == 3 and t.shape[-1] in (1, 3, 4):
                return 1
    except Exception:
        pass
    return 1


def _count_image_units(items: List[Any]) -> int:
    return max(1, sum(_image_unit_count(x) for x in items))


def _split_image_tensor(t: torch.Tensor) -> List[torch.Tensor]:
    if t.ndim == 3:
        return [t.unsqueeze(0)]
    return [t[i:i + 1] for i in range(t.shape[0])]


def _split_mask_tensor(t: torch.Tensor) -> List[torch.Tensor]:
    if t.ndim == 2:
        return [t.unsqueeze(0)]
    return [t[i:i + 1] for i in range(t.shape[0])]


def _iter_container_values(obj: Any) -> List[Any]:
    """尽可能安全地展开自定义批量容器。

    GJJ_BATCH_IMAGE 不一定是 dict/list，也可能是带 __dict__ 的自定义对象，
    或实现了 __iter__ 的容器。V28 只扫 dict/list，所以某些加载器只统计到 1 张。
    """
    values: List[Any] = []

    if obj is None or isinstance(obj, (str, bytes, bytearray)) or torch.is_tensor(obj):
        return values

    if isinstance(obj, dict):
        return list(obj.values())

    if isinstance(obj, (list, tuple, set)):
        return list(obj)

    # 优先读取常见批量字段，兼容不同 GJJ 批量容器/图片队列实现。
    common_names = (
        "images", "image", "imgs", "batch", "batches", "queue", "items",
        "data", "samples", "frames", "outputs", "values", "selected",
        "selected_images", "image_list", "image_queue", "pictures", "pics",
        "图片", "图片列表", "批量图片", "批量图片队列",
    )
    for name in common_names:
        try:
            if hasattr(obj, name):
                v = getattr(obj, name)
                if v is not None and v is not obj:
                    values.append(v)
        except Exception:
            pass

    # 自定义 class / dataclass / SimpleNamespace。
    try:
        d = vars(obj)
        if isinstance(d, dict):
            values.extend(d.values())
    except Exception:
        pass

    # namedtuple。
    try:
        if hasattr(obj, "_asdict"):
            d = obj._asdict()
            if isinstance(d, dict):
                values.extend(d.values())
    except Exception:
        pass

    # 最后兜底：可迭代容器。注意不要迭代 Tensor/String。
    try:
        if hasattr(obj, "__iter__"):
            values.extend(list(obj))
    except Exception:
        pass

    return values


def _collect_images(obj: Any, _seen: set[int] | None = None) -> List[torch.Tensor]:
    """递归收集所有图片 Tensor。

    V29 修复点：
    - 容器本身也加入 seen，避免自引用死循环。
    - 支持自定义对象容器（__dict__ / attributes / iterable），不只支持 dict/list。
    - 对 4D IMAGE Tensor 按 batch 维拆成单张，状态栏数量才是真实图片数。
    """
    if _seen is None:
        _seen = set()

    found: List[torch.Tensor] = []
    if obj is None:
        return found

    oid = id(obj)
    if oid in _seen:
        return found
    _seen.add(oid)

    if _is_image_tensor(obj):
        found.extend(_split_image_tensor(obj))
        return found

    for value in _iter_container_values(obj):
        found.extend(_collect_images(value, _seen))
    return found


def _collect_masks(obj: Any, _seen: set[int] | None = None) -> List[torch.Tensor]:
    """递归收集遮罩 Tensor，和图片收集逻辑保持一致。"""
    if _seen is None:
        _seen = set()

    found: List[torch.Tensor] = []
    if obj is None:
        return found

    oid = id(obj)
    if oid in _seen:
        return found
    _seen.add(oid)

    if _is_mask_tensor(obj) and not _is_image_tensor(obj):
        found.extend(_split_mask_tensor(obj))
        return found

    for value in _iter_container_values(obj):
        found.extend(_collect_masks(value, _seen))
    return found


def _replace_images_like(obj: Any, processed: Iterator[torch.Tensor]) -> Any:
    """尽量保留 GJJ_BATCH_IMAGE 原始容器结构，只替换其中的图片 Tensor。"""
    if _is_image_tensor(obj):
        count = 1 if obj.ndim == 3 else obj.shape[0]
        imgs = []
        for _ in range(count):
            try:
                imgs.append(next(processed))
            except StopIteration:
                break
        if not imgs:
            return obj
        return imgs[0].squeeze(0) if obj.ndim == 3 else torch.cat(imgs, dim=0)

    if isinstance(obj, dict):
        out = dict(obj)
        for key, value in list(out.items()):
            out[key] = _replace_images_like(value, processed)
        return out

    if isinstance(obj, list):
        return [_replace_images_like(v, processed) for v in obj]

    if isinstance(obj, tuple):
        return tuple(_replace_images_like(v, processed) for v in obj)

    return obj


def _pack_output_like(original: Any, processed: List[torch.Tensor]) -> Any:
    if not processed:
        return original
    # 普通 IMAGE Tensor：直接返回 batch tensor。
    if _is_image_tensor(original):
        return processed[0].squeeze(0) if original.ndim == 3 and len(processed) == 1 else torch.cat(processed, dim=0)
    # dict/list/tuple 容器可以尝试保留结构。
    if isinstance(original, (dict, list, tuple)):
        try:
            replaced = _replace_images_like(original, iter(processed))
            return replaced
        except Exception:
            pass
    # 自定义对象容器不强行原地替换，避免返回未处理的原容器；直接返回 IMAGE batch。
    return torch.cat(processed, dim=0)


def _pack_image_batch(processed: List[torch.Tensor]) -> torch.Tensor:
    """输出标准 IMAGE batch，避免 INPUT_IS_LIST 下游收到 list[1张batch]。"""
    if not processed:
        return torch.zeros((1, 64, 64, 3), dtype=torch.float32)
    normalized: List[torch.Tensor] = []
    max_h = 1
    max_w = 1
    max_c = 3
    dtype = processed[0].dtype
    for img in processed:
        if img.ndim == 3:
            img = img.unsqueeze(0)
        img = img.detach().cpu()
        normalized.append(img)
        max_h = max(max_h, int(img.shape[1]))
        max_w = max(max_w, int(img.shape[2]))
        max_c = max(max_c, int(img.shape[3]))
        dtype = img.dtype
    packed: List[torch.Tensor] = []
    for img in normalized:
        if int(img.shape[1]) == max_h and int(img.shape[2]) == max_w and int(img.shape[3]) == max_c:
            packed.append(img)
            continue
        canvas = torch.zeros((int(img.shape[0]), max_h, max_w, max_c), dtype=dtype)
        canvas[:, : int(img.shape[1]), : int(img.shape[2]), : int(img.shape[3])] = img.to(dtype=dtype)
        if max_c == 4 and int(img.shape[3]) < 4:
            canvas[..., 3:4] = 1.0
        packed.append(canvas)
    return torch.cat(packed, dim=0)


def _make_preview_payload(image: Any, max_edge: int = 512, original_width: int = 0, original_height: int = 0) -> Dict[str, Any] | None:
    """把输出 batch 的第一张图转成前端 canvas 预览用的小 PNG data URL。"""
    try:
        if isinstance(image, (list, tuple)) and image:
            image = image[0]
        if isinstance(image, dict):
            image = next((v for v in image.values() if torch.is_tensor(v)), None)
        if not torch.is_tensor(image):
            return None

        tensor = image[0] if image.ndim == 4 else image
        if tensor.ndim != 3:
            return None

        tensor = tensor.detach().cpu().float()
        if int(tensor.shape[-1]) == 1:
            tensor = tensor.repeat(1, 1, 3)
        elif int(tensor.shape[-1]) > 4:
            tensor = tensor[..., :4]

        tensor = tensor.clamp(0.0, 1.0)
        height = int(tensor.shape[0])
        width = int(tensor.shape[1])
        channels = int(tensor.shape[2])
        mode = "RGBA" if channels == 4 else "RGB"
        if channels < 3:
            return None

        array = tensor.mul(255.0).round().to(torch.uint8).numpy()
        pil_image = Image.fromarray(array, mode=mode)
        if max(pil_image.width, pil_image.height) > int(max_edge):
            pil_image.thumbnail((int(max_edge), int(max_edge)), Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG", optimize=True)
        data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        return {
            "src": data_url,
            "width": width,
            "height": height,
            "original_width": int(original_width or 0),
            "original_height": int(original_height or 0),
            "preview_width": int(pil_image.width),
            "preview_height": int(pil_image.height),
            "count": int(image.shape[0]) if getattr(image, "ndim", 0) == 4 else 1,
        }
    except Exception:
        return None


# ============================================================
# 图像缩放核心
# ============================================================

def _resize_one(image: torch.Tensor, mask: torch.Tensor | None, cfg: Dict[str, Any]) -> Tuple[torch.Tensor, torch.Tensor | None, int, int, int, int]:
    if image.ndim == 3:
        image = image.unsqueeze(0)
    b, h0, w0, c = image.shape

    mode = _mode(cfg.get("mode"))
    fit = _fit(cfg.get("fit_mode"))
    method = _method(cfg.get("upscale_method"))
    position = _position(cfg.get("crop_position"))
    multiple = cfg.get("round_to_multiple", "16")

    if cfg.get("device") == "GPU" and method != "lanczos":
        work_device = model_management.get_torch_device()
    else:
        work_device = torch.device("cpu")

    if mode == "宽高":
        target_w = max(1, _to_int(cfg.get("width"), w0))
        target_h = max(1, _to_int(cfg.get("height"), h0))
    elif mode == "长边":
        side = max(1, _to_int(cfg.get("long_side_length"), max(w0, h0)))
        ratio = side / max(1, max(w0, h0))
        target_w = max(1, int(round(w0 * ratio)))
        target_h = max(1, int(round(h0 * ratio)))
    elif mode == "像素":
        total_px = max(1, _to_int(cfg.get("total_pixel_k"), 1024)) * 1000
        ratio = _aspect_ratio(cfg.get("aspect_ratio"), w0, h0, cfg.get("proportional_width"), cfg.get("proportional_height"))
        target_w = max(1, int(round(math.sqrt(total_px * ratio))))
        target_h = max(1, int(round(target_w / ratio)))
    else:  # 等比
        scale = max(0.001, _to_float(cfg.get("scale_percent"), 100.0) / 100.0)
        target_w = max(1, int(round(w0 * scale)))
        target_h = max(1, int(round(h0 * scale)))

    if fit == "border":
        border_left = max(0, _to_int(cfg.get("border_left", 0), 0))
        border_top = max(0, _to_int(cfg.get("border_top", 0), 0))
        border_right = max(0, _to_int(cfg.get("border_right", 0), 0))
        border_bottom = max(0, _to_int(cfg.get("border_bottom", 0), 0))
        target_w = max(1, w0 + border_left + border_right)
        target_h = max(1, h0 + border_top + border_bottom)
    else:
        border_left = border_top = border_right = border_bottom = 0
        target_w = _ceil_to_multiple(target_w, multiple)
        target_h = _ceil_to_multiple(target_h, multiple)

    img = image.to(work_device)
    msk = None if mask is None else mask
    if msk is not None:
        if msk.ndim == 2:
            msk = msk.unsqueeze(0)
        if msk.shape[-2:] != (h0, w0):
            msk = common_upscale(msk.unsqueeze(1), w0, h0, "bilinear", crop="disabled").squeeze(1)
        msk = msk.to(work_device)

    def upscale_image(x: torch.Tensor, ow: int, oh: int) -> torch.Tensor:
        return common_upscale(x.movedim(-1, 1), ow, oh, method, crop="disabled").movedim(1, -1)

    def upscale_mask(x: torch.Tensor, ow: int, oh: int) -> torch.Tensor:
        use_method = "bilinear" if method == "lanczos" else method
        return common_upscale(x.unsqueeze(1), ow, oh, use_method, crop="disabled").squeeze(1)

    def feather_mask(x: torch.Tensor) -> torch.Tensor:
        feather = max(0, _to_int(cfg.get("pad_feather"), 0))
        if feather <= 0:
            return x
        kernel = max(3, feather * 2 + 1)
        if kernel % 2 == 0:
            kernel += 1
        value = x.unsqueeze(1).float()
        passes = max(1, min(4, int(math.ceil(feather / 8))))
        for _ in range(passes):
            value = F.avg_pool2d(value, kernel_size=kernel, stride=1, padding=kernel // 2)
        return value.squeeze(1).clamp(0.0, 1.0).to(dtype=x.dtype)

    # 等比/长边模式本身已经按比例算目标尺寸；适配方式不再额外裁剪/补边。
    if fit == "stretch" or mode in ("等比", "长边"):
        out = upscale_image(img, target_w, target_h)
        out_mask = None if msk is None else upscale_mask(msk, target_w, target_h)
        return out.cpu(), None if out_mask is None else out_mask.cpu(), w0, h0, target_w, target_h

    if fit == "border":
        fit_w = w0
        fit_h = h0
        scale = 1.0
    else:
        fit_w = target_w
        fit_h = target_h
        scale = min(target_w / max(1, w0), target_h / max(1, h0)) if fit == "letterbox" else max(target_w / max(1, w0), target_h / max(1, h0))
    inner_w = max(1, int(round(w0 * scale)))
    inner_h = max(1, int(round(h0 * scale)))
    resized = upscale_image(img, inner_w, inner_h)
    resized_mask = None if msk is None else upscale_mask(msk, inner_w, inner_h)

    if fit == "crop":
        x = _axis_offset(inner_w - target_w, position, "x")
        y = _axis_offset(inner_h - target_h, position, "y")
        out = resized[:, y:y + target_h, x:x + target_w, :]
        out_mask = None if resized_mask is None else resized_mask[:, y:y + target_h, x:x + target_w]
        return out.cpu(), None if out_mask is None else out_mask.cpu(), w0, h0, target_w, target_h

    # Letterbox / Border padding：补边颜色只在这里生效。
    rgb = torch.tensor(_parse_color(cfg.get("pad_color")), dtype=resized.dtype, device=resized.device)
    out = torch.zeros((resized.shape[0], target_h, target_w, resized.shape[-1]), dtype=resized.dtype, device=resized.device)
    if resized.shape[-1] >= 3:
        out[..., 0:3] = rgb.view(1, 1, 1, 3)
        if resized.shape[-1] == 4:
            out[..., 3:4] = 1.0
    else:
        out[..., 0:1] = rgb[0].view(1, 1, 1, 1)
    if fit == "border":
        x = border_left + _axis_offset(fit_w - inner_w, position, "x")
        y = border_top + _axis_offset(fit_h - inner_h, position, "y")
    else:
        x = _axis_offset(target_w - inner_w, position, "x")
        y = _axis_offset(target_h - inner_h, position, "y")
    out[:, y:y + inner_h, x:x + inner_w, :] = resized

    if resized_mask is not None:
        out_mask = torch.ones((resized.shape[0], target_h, target_w), dtype=resized_mask.dtype, device=resized_mask.device)
        out_mask[:, y:y + inner_h, x:x + inner_w] = resized_mask
    else:
        out_mask = torch.ones((resized.shape[0], target_h, target_w), dtype=torch.float32, device=resized.device)
        out_mask[:, y:y + inner_h, x:x + inner_w] = 0.0
        out_mask = feather_mask(out_mask)
    return out.cpu(), None if out_mask is None else out_mask.cpu(), w0, h0, target_w, target_h


class GJJ_ImageResizeKJv2:
    INPUT_IS_LIST = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("GJJ_BATCH_IMAGE,IMAGE", {
                    "display_name": "🖼️ 图片",
                    "tooltip": "输入图片。支持 IMAGE Tensor、GJJ_BATCH_IMAGE 多图队列、list、dict 批量容器。Input image / batch image container."
                }),
                "config_json": ("STRING", {
                    "default": json.dumps(_default_config(), ensure_ascii=False),
                    "multiline": False,
                    "display_name": "隐藏配置",
                    "tooltip": "前端面板写入的 JSON 配置。Internal JSON config written by the frontend UI.",
                    # 这些标记前端会识别并彻底隐藏；旧版前端不支持时，也会尽量不生成可见控件。
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False
                }),
            },
            "optional": {
                "target_width": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "📐 目标宽度",
                    "tooltip": "目标宽度。宽高模式下显示；其它模式隐藏。可手填，也可连接外部 INT。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "target_height": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "📐 目标高度",
                    "tooltip": "目标高度。宽高模式下显示；其它模式隐藏。可手填，也可连接外部 INT。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "border_left": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "⬅️ 左",
                    "tooltip": "补边模式下左侧预留的补边宽度。会在目标宽度内计算，不会改变目标宽度。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "border_top": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "⬆️ 上",
                    "tooltip": "补边模式下上侧预留的补边高度。会在目标高度内计算，不会改变目标高度。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "border_right": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "➡️ 右",
                    "tooltip": "补边模式下右侧预留的补边宽度。会在目标宽度内计算，不会改变目标宽度。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "border_bottom": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "⬇️ 下",
                    "tooltip": "补边模式下下侧预留的补边高度。会在目标高度内计算，不会改变目标高度。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "scale_percent": ("FLOAT", {
                    "default": 100.0,
                    "min": 0.1,
                    "max": 10000.0,
                    "step": 1.0,
                    "display_name": "📊 缩放百分比",
                    "tooltip": "缩放百分比。等比模式下显示；其它模式隐藏。可手填，也可连接外部 FLOAT。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "long_side_length": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": MAX_RESOLUTION,
                    "step": 8,
                    "display_name": "📏 长边长度",
                    "tooltip": "长边长度。长边模式下显示；其它模式隐藏。可手填，也可连接外部 INT。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "total_pixel_k": ("INT", {
                    "default": 260,
                    "min": 1,
                    "max": 1000000,
                    "step": 1,
                    "display_name": "🧮 总像素/K",
                    "tooltip": "总像素，单位 K。像素模式下显示；其它模式隐藏。可手填，也可连接外部 INT。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "aspect_ratio": (["原始比例", "自定义", "1:1", "3:2", "4:3", "16:9", "2:3", "3:4", "9:16"], {
                    "default": "1:1",
                    "display_name": "🖼️ 输出比例",
                    "tooltip": "输出比例。像素模式下显示；保留原生下拉选项，也可连接外部 STRING。",
                    "hidden": True,
                    "display": "hidden",
                    "forceInput": False,
                }),
                "mask": ("MASK", {"display_name": "🎭 遮罩", "tooltip": "可选遮罩，会与图片同步缩放。Optional mask."}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE", "MASK", "*", "*", "*")
    RETURN_NAMES = ("图片", "遮罩", "扩展输出 1", "扩展输出 2", "扩展输出 3")
    FUNCTION = "resize"
    CATEGORY = "GJJ/image"
    DESCRIPTION = """
GJJ · 🔍 多功能图片缩放

用途：
- 单图或 GJJ_BATCH_IMAGE 批量图片缩放。
- 支持【宽高】【等比】【长边】【像素】四种模式。
- 支持拉伸 Stretch、补边 Add Border、留边填充 Letterbox/Padding、裁剪填满 Crop Fill。
- 补边模式按外补画板逻辑使用左/上/右/下扩展画布，并复用边缘羽化参数。
- 支持动态扩展输出：原始尺寸、输出高度、输出宽度。

输入：
- 图片：GJJ_BATCH_IMAGE,IMAGE。
- 遮罩：MASK，可选。
  - 补边 / 留边填充且未接入遮罩时，会自动把补边填充区域输出为遮罩。

输出：
- 图片：GJJ_BATCH_IMAGE,IMAGE，尽量保持输入批量容器结构。
- 遮罩：MASK。接入遮罩时同步缩放/裁剪；无遮罩补边或留边填充时输出补边区域。
- 扩展输出 1-3：由前端按钮动态决定。

依赖：
- torch：ComfyUI 标准依赖，用于 Tensor 运算。
- Pillow/PIL：ComfyUI 标准依赖，用于颜色解析。
- comfy.utils.common_upscale：ComfyUI 内置缩放函数。

模型：
- 本节点不需要任何模型。
- 如果缺失依赖或输入异常，节点会在控制台打印错误原因，并尽量返回原图，避免中断整个流程。
"""

    def resize(self, image, config_json, unique_id=None, target_width=None, target_height=None, border_left=None, border_top=None, border_right=None, border_bottom=None, scale_percent=None, long_side_length=None, total_pixel_k=None, aspect_ratio=None, mask=None):
        start = time.time()
        try:
            config_json = _unwrap_list_param(config_json)
            unique_id = _unwrap_list_param(unique_id)

            cfg = _load_config(config_json)
            target_width = _unwrap_list_param(target_width)
            target_height = _unwrap_list_param(target_height)
            border_left = _unwrap_list_param(border_left)
            border_top = _unwrap_list_param(border_top)
            border_right = _unwrap_list_param(border_right)
            border_bottom = _unwrap_list_param(border_bottom)
            scale_percent = _unwrap_list_param(scale_percent)
            long_side_length = _unwrap_list_param(long_side_length)
            total_pixel_k = _unwrap_list_param(total_pixel_k)
            aspect_ratio = _unwrap_list_param(aspect_ratio)
            if target_width is not None:
                cfg["width"] = max(1, _to_int(target_width, cfg.get("width", 1024)))
            if target_height is not None:
                cfg["height"] = max(1, _to_int(target_height, cfg.get("height", 1024)))
            if border_left is not None:
                cfg["border_left"] = max(0, _to_int(border_left, cfg.get("border_left", 0)))
            if border_top is not None:
                cfg["border_top"] = max(0, _to_int(border_top, cfg.get("border_top", 0)))
            if border_right is not None:
                cfg["border_right"] = max(0, _to_int(border_right, cfg.get("border_right", 0)))
            if border_bottom is not None:
                cfg["border_bottom"] = max(0, _to_int(border_bottom, cfg.get("border_bottom", 0)))
            if scale_percent is not None:
                cfg["scale_percent"] = max(0.001, _to_float(scale_percent, cfg.get("scale_percent", 100.0)))
            if long_side_length is not None:
                cfg["long_side_length"] = max(1, _to_int(long_side_length, cfg.get("long_side_length", 1024)))
            if total_pixel_k is not None:
                cfg["total_pixel_k"] = max(1, _to_int(total_pixel_k, cfg.get("total_pixel_k", 260)))
            if aspect_ratio is not None:
                cfg["aspect_ratio"] = str(aspect_ratio)

            # INPUT_IS_LIST=True 或某些批量节点会把端口值包一层 list。
            # 统计只看输入源；输出逻辑保持 v29，不额外复杂化。
            image_source = image[0] if isinstance(image, (list, tuple)) and len(image) == 1 else image
            mask_source = mask[0] if isinstance(mask, (list, tuple)) and len(mask) == 1 else mask

            images = _collect_images(image_source)
            masks = _collect_masks(mask_source)
            if not images:
                raise ValueError("没有检测到有效图片。请连接 IMAGE 或 GJJ_BATCH_IMAGE。")

            input_total = _count_image_units(images)
            stat = _begin_run_call(unique_id, input_total)
            total = int(stat.get("total", input_total))
            done_before = int(stat.get("done", 0))
            _send_status(unique_id, "running", f"正在处理：累计 {done_before}/{total} 张图片…", progress=done_before / max(1, total), total=total, index=done_before)

            processed_images: List[torch.Tensor] = []
            processed_masks: List[torch.Tensor] = []
            first_orig_w = first_orig_h = first_out_w = first_out_h = 0
            done_units = 0

            for idx, img in enumerate(images):
                unit_count = _image_unit_count(img)
                start_index = done_before + done_units + 1
                end_index = min(total, done_before + done_units + unit_count)
                _send_status(
                    unique_id,
                    "running",
                    f"正在处理第 {start_index}-{end_index}/{total} 张图片…" if unit_count > 1 else f"正在处理第 {start_index}/{total} 张图片…",
                    progress=(done_before + done_units) / max(1, total),
                    total=total,
                    index=done_before + done_units,
                )
                m = masks[idx] if idx < len(masks) else None
                out_img, out_mask, ow, oh, tw, th = _resize_one(img, m, cfg)
                processed_images.append(out_img)
                if out_mask is not None:
                    processed_masks.append(out_mask)
                done_units += unit_count
                if idx == 0:
                    first_orig_w, first_orig_h, first_out_w, first_out_h = ow, oh, tw, th

            out_image = _pack_image_batch(processed_images)
            out_mask = torch.cat(processed_masks, dim=0) if processed_masks else torch.zeros((1, 64, 64), dtype=torch.float32)

            selected = cfg.get("extra_outputs", [])
            if not isinstance(selected, list):
                selected = []
            values: Dict[str, Any] = {
                "original_size": [int(first_orig_w), int(first_orig_h)],
                "output_height": int(first_out_h),
                "output_width": int(first_out_w),
                "image_count": int(done_units),
            }
            extras = [values.get(k, None) for k in selected[:3]]
            while len(extras) < 3:
                extras.append(None)

            # 不在每次单图调用里打印“完成 1 张”作为最终结果。
            # 这里只更新全局统计并发送运行中状态；真正的“共处理 N 张/总耗时”
            # 由 _finalize_run_status 防抖汇总后统一输出。
            stat = _finish_run_call(unique_id, done_units, first_orig_w, first_orig_h, first_out_w, first_out_h)
            done_total = int(stat.get("done", done_before + done_units))
            total = int(stat.get("total", total))
            elapsed = _run_elapsed(stat)
            print(f"[GJJ 多功能图片缩放] 进度：{done_total}/{total} 张，当前首图 {first_orig_w}x{first_orig_h} -> {first_out_w}x{first_out_h}，累计耗时 {elapsed:.2f}s")
            _send_status(unique_id, "running", f"已处理 {done_total}/{total} 张，累计耗时 {elapsed:.2f} 秒", progress=done_total / max(1, total), total=total, index=done_total, elapsed=elapsed)
            result = (out_image, out_mask, extras[0], extras[1], extras[2])
            preview = _make_preview_payload(out_image, original_width=first_orig_w, original_height=first_orig_h)
            if preview:
                return {
                    "ui": {
                        "gjj_image_resize_kjv2_preview": [preview],
                    },
                    "result": result,
                }
            return result

        except Exception as e:
            key = _run_key(unique_id)
            stat = _GJJ_RESIZE_RUN_STATS.get(key)
            elapsed = _run_elapsed(stat) if stat else (time.time() - start)
            msg = f"GJJ 多功能图片缩放执行失败：{e}\n{traceback.format_exc()}"
            print(msg)
            _send_status(unique_id, "error", f"执行错误：{e}。请检查输入图片、尺寸参数和依赖。", progress=1.0, elapsed=elapsed)
            empty_mask = torch.zeros((1, 64, 64), dtype=torch.float32)
            return (image, empty_mask, msg, None, None)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageResizeKJv2}
print("[GJJ 多功能图片缩放] 当前版本: V46_SEMANTIC_PARAM_LINK_REPAIR", __file__)
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔍 多功能图片缩放"}
