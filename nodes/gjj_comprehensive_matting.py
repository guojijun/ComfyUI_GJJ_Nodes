from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import safetensors.torch
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter
from torchvision import transforms
from torchvision.transforms.functional import to_pil_image

import folder_paths

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_ComprehensiveMatting"
METHOD_RMBG2 = "RMBG2"
METHOD_BIREF_GENERAL = "BiRefNet 通用"
METHOD_BIREF_MATTING = "BiRefNet 精细"
METHOD_BEN2 = "BEN2"
METHOD_INSPYRENET = "Inspyrenet"
METHODS = [METHOD_RMBG2, METHOD_BIREF_GENERAL, METHOD_BIREF_MATTING, METHOD_BEN2, METHOD_INSPYRENET]
METHOD_OUTPUT_SUFFIXES = {
    METHOD_RMBG2: "RMBG2",
    METHOD_BIREF_GENERAL: "BiRef通用",
    METHOD_BIREF_MATTING: "BiRef精细",
    METHOD_BEN2: "BEN2",
    METHOD_INSPYRENET: "Inspyrenet",
}

MODEL_INPUT_SIZE = 1024
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

_MODEL_CACHE: dict[tuple[str, str, str], object] = {}
_RMBG2_COMPONENTS: tuple[type, type] | None = None
_BIREFNET_CLASS: type | None = None
_BEN2_CLASS: type | None = None
_INSPYRENET_REMOVER_CACHE: dict[tuple[str, str, bool], object] = {}


@contextmanager
def _force_cpu_tensor_construction():
    patched_names = ["linspace", "zeros", "ones", "empty", "full", "rand", "randn", "arange"]
    originals: dict[str, object] = {}

    def _wrap_constructor(fn):
        def _wrapped(*args, **kwargs):
            if kwargs.get("device") is None:
                kwargs["device"] = "cpu"
            return fn(*args, **kwargs)

        return _wrapped

    previous_default_device = None
    can_restore_default_device = hasattr(torch, "get_default_device") and hasattr(torch, "set_default_device")
    if can_restore_default_device:
        try:
            previous_default_device = torch.get_default_device()
            torch.set_default_device("cpu")
        except Exception:
            previous_default_device = None

    previous_current_device = None
    torch_device_module = None
    try:
        import torch.utils._device as torch_device_module  # type: ignore

        previous_current_device = getattr(torch_device_module, "CURRENT_DEVICE", None)
        torch_device_module.CURRENT_DEVICE = torch.device("cpu")
    except Exception:
        torch_device_module = None

    try:
        for name in patched_names:
            if hasattr(torch, name):
                originals[name] = getattr(torch, name)
                setattr(torch, name, _wrap_constructor(getattr(torch, name)))
        yield
    finally:
        for name, original in originals.items():
            setattr(torch, name, original)
        if torch_device_module is not None:
            try:
                torch_device_module.CURRENT_DEVICE = previous_current_device
            except Exception:
                pass
        if can_restore_default_device and previous_default_device is not None:
            try:
                torch.set_default_device(previous_default_device)
            except Exception:
                pass


def _candidate_model_roots() -> list[Path]:
    roots: list[Path] = []
    try:
        mod_models = Path(__file__).resolve().parents[3] / "models"
        roots.append(mod_models)
    except Exception:
        pass
    try:
        roots.append(Path(folder_paths.models_dir))
    except Exception:
        pass
    seen: set[str] = set()
    unique: list[Path] = []
    for root in roots:
        key = str(root).lower()
        if key not in seen and root.exists():
            seen.add(key)
            unique.append(root)
    return unique


def _display_model_path(path: Path) -> str:
    resolved = path.resolve()
    for root in _candidate_model_roots():
        try:
            relative = resolved.relative_to(root.resolve())
            return str(Path("models") / relative).replace("\\", "/")
        except ValueError:
            continue
    return str(Path("models") / resolved.name).replace("\\", "/")


def _score_model_path(path: Path, includes: tuple[str, ...], excludes: tuple[str, ...] = ()) -> int:
    text = str(path).replace("\\", "/").lower()
    name = path.name.lower()
    if any(item.lower() in text for item in excludes):
        return -10000
    score = 0
    for index, token in enumerate(includes):
        token = token.lower()
        if name == f"{token}{path.suffix.lower()}":
            score += 120
        if token in name:
            score += 60 - index
        elif token in text:
            score += 20 - index
        else:
            return -10000
    if "/rmbg/" in text:
        score += 10
    if "/birefnet/" in text:
        score += 10
    if "/ben" in text:
        score += 8
    if "/inspyrenet" in text or "inspyrenet" in name:
        score += 8
    return score


def _find_model_file(
    display_name: str,
    include_sets: tuple[tuple[str, ...], ...],
    exts: tuple[str, ...],
    excludes: tuple[str, ...] = (),
) -> Path:
    candidates: list[tuple[int, Path]] = []
    for root in _candidate_model_roots():
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in exts:
                continue
            best = max(_score_model_path(path, includes, excludes) for includes in include_sets)
            if best > -10000:
                candidates.append((best, path))
    if candidates:
        candidates.sort(key=lambda item: (-item[0], len(str(item[1])), str(item[1]).lower()))
        return candidates[0][1]
    raise RuntimeError(f"未找到 {display_name} 模型文件。已在 models 目录下相关子目录模糊搜索。")


def _resolve_model_path(method: str) -> Path:
    if method == METHOD_RMBG2:
        return _find_model_file("RMBG2", (("rmbg2",), ("rmbg-2",)), (".safetensors", ".pth"))
    if method == METHOD_BIREF_GENERAL:
        return _find_model_file(
            "BiRefNet General",
            (("general",), ("birefnet", "general")),
            (".safetensors", ".pth"),
            excludes=("matting", "lite", "hr"),
        )
    if method == METHOD_BIREF_MATTING:
        return _find_model_file(
            "BiRefNet Matting",
            (("matting",), ("birefnet", "matting")),
            (".safetensors", ".pth"),
            excludes=("lite", "hr"),
        )
    if method == METHOD_BEN2:
        return _find_model_file("BEN2", (("ben2", "base"), ("ben2",)), (".pth",))
    if method == METHOD_INSPYRENET:
        return _find_model_file("InSPyReNet", (("inspyrenet",), ("inspyr",), ("isnet",)), (".pth", ".pt"))
    raise RuntimeError(f"未知抠图方式：{method}")


def _method_model_status() -> dict[str, dict[str, str | bool]]:
    status: dict[str, dict[str, str | bool]] = {}
    for method in METHODS:
        try:
            path = _resolve_model_path(method)
            display_path = _display_model_path(path)
            status[method] = {
                "available": True,
                "model_name": path.name,
                "model_path": display_path,
            }
        except Exception:
            status[method] = {
                "available": False,
                "model_name": "未找到",
                "model_path": "",
                "message": "已在 models 下相关目录模糊搜索，但没有匹配文件。",
            }
    return status


def _method_tooltip_text(status: dict[str, dict[str, str | bool]]) -> str:
    lines = [
        "选择综合抠图方式。",
        "按钮支持普通点击单选；按 Shift 点击可多选/取消路线。",
        "",
        "模型搜索结果：",
    ]
    for method in METHODS:
        item = status.get(method, {})
        if item.get("available"):
            lines.append(f"- {method}")
            lines.append(f"  模型：{item.get('model_name')}")
            lines.append(f"  路径：{item.get('model_path')}")
        else:
            lines.append(f"- {method}")
            lines.append("  模型：未找到")
    return "<br>".join(lines)


def _select_device(device: str) -> torch.device:
    if device == "CPU":
        return torch.device("cpu")
    if device == "GPU":
        if not torch.cuda.is_available():
            raise RuntimeError("当前环境没有可用 CUDA，无法使用 GPU。")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _tensor_to_pil_list(tensor: torch.Tensor) -> list[Image.Image]:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    return [
        Image.fromarray(np.clip(255.0 * tensor[index].cpu().numpy(), 0, 255).astype(np.uint8))
        for index in range(tensor.shape[0])
    ]


def _pil_list_to_tensor(images: list[Image.Image]) -> torch.Tensor:
    tensors = []
    for image in images:
        array = np.array(image, dtype=np.float32) / 255.0
        if array.ndim == 2:
            array = array[:, :, None]
        tensors.append(torch.from_numpy(array))
    return torch.stack(tensors, dim=0)


def _normalize_state_dict_keys(state_dict: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    if state_dict and all(key.startswith("module.") for key in state_dict):
        return {key[7:]: value for key, value in state_dict.items()}
    return state_dict


def _load_rmbg2_components() -> tuple[type, type]:
    global _RMBG2_COMPONENTS
    if _RMBG2_COMPONENTS is not None:
        return _RMBG2_COMPONENTS

    model_root = Path(__file__).resolve().parents[1] / "utils" / "rmbg2_model"
    config_path = model_root / "BiRefNet_config.py"
    network_path = model_root / "birefnet.py"
    if not config_path.exists() or not network_path.exists():
        raise RuntimeError(f"RMBG2 模型代码缺失，请检查目录：{model_root}")

    package_name = "gjj_rmbg2_model"
    package = sys.modules.get(package_name)
    if package is None:
        package = types.ModuleType(package_name)
        package.__path__ = [str(model_root)]  # type: ignore[attr-defined]
        sys.modules[package_name] = package

    def _load_module(module_name: str, file_path: Path):
        existing = sys.modules.get(module_name)
        if existing is not None:
            return existing
        spec = importlib.util.spec_from_file_location(module_name, str(file_path))
        if spec is None or spec.loader is None:
            raise RuntimeError(f"无法加载模块：{file_path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module

    config_module = _load_module(f"{package_name}.BiRefNet_config", config_path)
    network_module = _load_module(f"{package_name}.birefnet", network_path)
    _RMBG2_COMPONENTS = (config_module.BiRefNetConfig, network_module.BiRefNet)
    return _RMBG2_COMPONENTS


def _load_birefnet_class() -> type:
    global _BIREFNET_CLASS
    if _BIREFNET_CLASS is not None:
        return _BIREFNET_CLASS

    vendor_root = Path(__file__).resolve().parents[1] / "vendor" / "birefnet_ll"
    if not vendor_root.exists():
        raise RuntimeError(f"BiRefNet 内置代码缺失，请检查目录：{vendor_root}")
    vendor_text = str(vendor_root)
    if vendor_text not in sys.path:
        sys.path.insert(0, vendor_text)
    from birefnet.models.birefnet import BiRefNet  # type: ignore

    _BIREFNET_CLASS = BiRefNet
    return _BIREFNET_CLASS


def _load_ben2_class() -> type:
    global _BEN2_CLASS
    if _BEN2_CLASS is not None:
        return _BEN2_CLASS

    model_code = _find_model_file("BEN2.py", (("ben2",),), (".py",))
    module_name = "gjj_ben2_model"
    spec = importlib.util.spec_from_file_location(module_name, str(model_code))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 BEN2 模型代码：{model_code}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    _BEN2_CLASS = module.BEN_Base
    return _BEN2_CLASS


def _load_rmbg2_model(weight_path: Path, device: torch.device) -> torch.nn.Module:
    cache_key = (METHOD_RMBG2, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    BiRefNetConfig, BiRefNet = _load_rmbg2_components()
    with _force_cpu_tensor_construction():
        model = BiRefNet(bb_pretrained=False, config=BiRefNetConfig(bb_pretrained=False))
        state_dict = safetensors.torch.load_file(str(weight_path), device="cpu") if weight_path.suffix == ".safetensors" else torch.load(str(weight_path), map_location="cpu")
        model.load_state_dict(_normalize_state_dict_keys(state_dict), strict=True)

    target_dtype = torch.float16 if device.type == "cuda" else torch.float32
    model.to(device=device, dtype=target_dtype)
    model.eval()
    _MODEL_CACHE[cache_key] = model
    return model


def _load_birefnet_model(method: str, weight_path: Path, device: torch.device) -> torch.nn.Module:
    cache_key = (method, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    BiRefNet = _load_birefnet_class()
    with _force_cpu_tensor_construction():
        model = BiRefNet(bb_pretrained=False, bb_index=6)
        state_dict = safetensors.torch.load_file(str(weight_path), device="cpu") if weight_path.suffix == ".safetensors" else torch.load(str(weight_path), map_location="cpu")
        model.load_state_dict(_normalize_state_dict_keys(state_dict), strict=True)

    target_dtype = torch.float16 if device.type == "cuda" else torch.float32
    model.to(device=device, dtype=target_dtype)
    model.eval()
    _MODEL_CACHE[cache_key] = model
    return model


def _load_ben2_model(weight_path: Path, device: torch.device) -> torch.nn.Module:
    cache_key = (METHOD_BEN2, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    BEN_Base = _load_ben2_class()
    model = BEN_Base().to(device).eval()
    model.loadcheckpoints(str(weight_path))
    _MODEL_CACHE[cache_key] = model
    return model


def _make_rgba_and_mask(original: Image.Image, mask: Image.Image) -> tuple[Image.Image, Image.Image]:
    mask = mask.convert("L")
    rgba = original.convert("RGBA")
    rgba.putalpha(mask)
    return rgba, mask


def _finish_outputs(rgba_images: list[Image.Image], masks: list[Image.Image], background: str) -> tuple[torch.Tensor, torch.Tensor]:
    if background in ("transparent", "透明"):
        image_tensor = _pil_list_to_tensor([item.convert("RGBA") for item in rgba_images])
    else:
        canvas_color = (255, 255, 255) if background in ("white", "白色") else (0, 0, 0)
        composed = []
        for layer in rgba_images:
            canvas = Image.new("RGB", layer.size, canvas_color)
            canvas.paste(layer.convert("RGB"), mask=layer.getchannel("A"))
            composed.append(canvas)
        image_tensor = _pil_list_to_tensor(composed)
    mask_tensor = _pil_list_to_tensor([item.convert("L") for item in masks]).squeeze(-1)
    return image_tensor, mask_tensor


def _collect_input_images(batch_image: torch.Tensor | None, image: torch.Tensor | None) -> list[Image.Image]:
    images: list[Image.Image] = []
    for value in (batch_image, image):
        if value is None:
            continue
        if not isinstance(value, torch.Tensor):
            continue
        tensor = value
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if tensor.ndim != 4:
            raise RuntimeError("综合抠图收到的图片张量格式不正确，应为 IMAGE 或 GJJ 批量图片。")
        images.extend(_tensor_to_pil_list(tensor.detach().float().contiguous()))
    if not images:
        raise RuntimeError("综合抠图至少需要连接 GJJ 批量图片或普通图像。")
    return images


def _parse_selected_methods(raw_value: str, fallback: str) -> list[str]:
    selected: list[str] = []
    text = str(raw_value or "").strip()
    if text:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                selected = [str(item) for item in parsed if str(item) in METHODS]
        except Exception:
            selected = [item.strip() for item in text.split(",") if item.strip() in METHODS]
    if not selected:
        selected = [fallback if fallback in METHODS else METHOD_RMBG2]

    ordered: list[str] = []
    for method in METHODS:
        if method in selected and method not in ordered:
            ordered.append(method)
    return ordered or [METHOD_RMBG2]


def _recover_selected_methods(raw_value: str, fallback: str, extra_pnginfo: Any = None, unique_id: Any = None) -> list[str]:
    if str(raw_value or "").strip():
        return _parse_selected_methods(raw_value, fallback)
    selected = _parse_selected_methods(raw_value, fallback)
    if not isinstance(extra_pnginfo, dict):
        return selected
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return selected
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return selected
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != NODE_NAME:
            continue
        if unique_id is not None and str(node.get("id")) != str(unique_id):
            continue
        properties = node.get("properties")
        if isinstance(properties, dict):
            text = str(properties.get("selected_methods_json") or "").strip()
            if text:
                return _parse_selected_methods(text, fallback)
        widget_values = node.get("widgets_values")
        if isinstance(widget_values, list):
            for value in widget_values:
                text = str(value or "")
                if any(method in text for method in METHODS):
                    return _parse_selected_methods(text, fallback)
    return selected


def _empty_route_output(reference: list[Image.Image], background: str) -> tuple[torch.Tensor, torch.Tensor]:
    width, height = reference[0].size if reference else (64, 64)
    alpha = Image.new("L", (width, height), 0)
    rgba = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image_tensor, mask_tensor = _finish_outputs([rgba], [alpha], background)
    return image_tensor.contiguous(), mask_tensor


def _postprocess_mask(mask: Image.Image, threshold: float, blur: float, invert: bool) -> Image.Image:
    if threshold > 0:
        arr = np.array(mask.convert("L"), dtype=np.uint8)
        arr = np.where(arr >= int(threshold * 255), 255, 0).astype(np.uint8)
        mask = Image.fromarray(arr, mode="L")
    if blur > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=float(blur)))
    if invert:
        arr = 255 - np.array(mask.convert("L"), dtype=np.uint8)
        mask = Image.fromarray(arr, mode="L")
    return mask


def _run_torch_mask_model(
    model: torch.nn.Module,
    images: list[Image.Image],
    device: torch.device,
    process_res: int,
) -> list[Image.Image]:
    input_size = max(64, int(process_res or MODEL_INPUT_SIZE))
    preprocess = transforms.Compose(
        [
            transforms.Resize((input_size, input_size)),
            transforms.ToTensor(),
            transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
        ]
    )
    input_images = torch.stack([preprocess(item.convert("RGB")) for item in images]).to(device)
    if device.type == "cuda":
        input_images = input_images.half()

    with torch.inference_mode():
        predictions = model(input_images)[-1].sigmoid().float().cpu()
    del input_images

    masks: list[Image.Image] = []
    for original, prediction in zip(images, predictions):
        resized = F.interpolate(
            prediction.unsqueeze(0),
            size=(original.height, original.width),
            mode="bilinear",
            align_corners=False,
        ).squeeze()
        masks.append(to_pil_image(resized.clamp(0, 1)))
    return masks


def _run_ben2(model: torch.nn.Module, images: list[Image.Image]) -> tuple[list[Image.Image], list[Image.Image]]:
    rgba_images: list[Image.Image] = []
    masks: list[Image.Image] = []
    resample_lanczos = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    with torch.inference_mode():
        for image in images:
            result = model.inference(image.convert("RGB"))
            if isinstance(result, Image.Image):
                rgba = result.convert("RGBA")
                if rgba.size != image.size:
                    rgba = rgba.resize(image.size, resample_lanczos)
                alpha = rgba.getchannel("A")
            else:
                mask = result[0] if isinstance(result, (tuple, list)) else result
                if not isinstance(mask, Image.Image):
                    mask = Image.fromarray(np.array(mask).astype(np.uint8))
                if mask.mode == "RGBA":
                    rgba = mask.convert("RGBA")
                    if rgba.size != image.size:
                        rgba = rgba.resize(image.size, resample_lanczos)
                    alpha = rgba.getchannel("A")
                else:
                    rgba, alpha = _make_rgba_and_mask(image, mask)
            rgba_images.append(rgba)
            masks.append(alpha)
    return rgba_images, masks


def _run_inspyrenet(
    images: list[Image.Image],
    weight_path: Path,
    device: torch.device,
    threshold: float,
    jit: bool,
) -> tuple[list[Image.Image], list[Image.Image]]:
    cache_key = (str(weight_path), str(device), bool(jit))
    remover = _INSPYRENET_REMOVER_CACHE.get(cache_key)
    if remover is None:
        from transparent_background import Remover  # type: ignore

        remover = Remover(jit=jit, device=str(device), ckpt=str(weight_path))
        _INSPYRENET_REMOVER_CACHE[cache_key] = remover

    rgba_images: list[Image.Image] = []
    masks: list[Image.Image] = []
    for image in images:
        kwargs = {"type": "rgba"}
        if threshold > 0:
            kwargs["threshold"] = threshold
        rgba = remover.process(image.convert("RGB"), **kwargs).convert("RGBA")
        rgba_images.append(rgba)
        masks.append(rgba.getchannel("A"))
    return rgba_images, masks


class GJJ_ComprehensiveMatting:
    CATEGORY = "GJJ"
    FUNCTION = "remove_background"
    DESCRIPTION = "综合抠图节点：RMBG2、BiRefNet 通用/精细、BEN2、Inspyrenet。模型会在 models 下相关目录模糊搜索。"
    SEARCH_ALIASES = ["rmbg", "remove background", "抠图", "去背景", "背景移除", "前景提取", "birefnet", "ben2", "inspyrenet"]
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)
    RETURN_NAMES = ("综合批量图",)
    OUTPUT_TOOLTIPS = ("把所有已选路线的结果按路线顺序合并成一个 GJJ 专用批量图片输出。",)

    @classmethod
    def INPUT_TYPES(cls):
        method_status = _method_model_status()
        return {
            "required": {
                "matting_method": (
                    METHODS,
                    {
                        "default": METHOD_RMBG2,
                        "display_name": "抠图方式",
                        "tooltip": _method_tooltip_text(method_status),
                    },
                ),
                "model_status_json": (
                    "STRING",
                    {
                        "default": json.dumps(method_status, ensure_ascii=False, indent=2),
                        "multiline": True,
                        "display_name": "模型状态",
                        "tooltip": "显示各抠图路线的模型可用状态、模型名和 models/相对路径；界面节点上会自动隐藏。",
                    },
                ),
                "selected_methods_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "多路选择",
                        "tooltip": "前端按钮维护的抠图路线列表。普通点击单选，Shift 点击可多选。",
                    },
                ),
                "background": (
                    ["透明", "白色", "黑色"],
                    {
                        "default": "透明",
                        "display_name": "背景填充",
                        "tooltip": "透明、白底或黑底输出。透明模式会保留 alpha 通道。",
                    },
                ),
                "device": (
                    ["自动", "GPU", "CPU"],
                    {
                        "default": "自动",
                        "display_name": "设备",
                        "tooltip": "Auto 会优先使用 CUDA。",
                    },
                ),
                "process_res": (
                    "INT",
                    {
                        "default": MODEL_INPUT_SIZE,
                        "min": 64,
                        "max": 4096,
                        "step": 64,
                        "display_name": "处理分辨率",
                        "tooltip": "RMBG2/BiRefNet 的内部推理分辨率。",
                    },
                ),
                "threshold": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "遮罩阈值",
                        "tooltip": "0 表示保留软遮罩；大于 0 时会二值化。",
                    },
                ),
                "mask_blur": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 64.0,
                        "step": 0.5,
                        "display_name": "遮罩模糊",
                        "tooltip": "对最终遮罩做高斯模糊。",
                    },
                ),
                "invert_output": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "反转遮罩",
                        "tooltip": "反转最终前景遮罩和透明通道。",
                    },
                ),
                "inspyrenet_jit": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "Inspyrenet JIT",
                        "tooltip": "仅 Inspyrenet 使用；首次运行会更慢。",
                    },
                ),
            },
            "optional": {
                "batch_image": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图",
                        "tooltip": "第一路输入。可直接接 GJJ · 批量多图片加载预览器，用同一组抠图参数批量去除背景。",
                    },
                ),
                "image": (
                    "IMAGE",
                    {
                        "display_name": "图像",
                        "tooltip": "兼容普通 IMAGE 或 IMAGE batch；若同时连接 GJJ 批量图片，会排在批量图片之后一起处理。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, matting_method, model_status_json, selected_methods_json, background, device, process_res, threshold, mask_blur, invert_output, inspyrenet_jit, batch_image=None, image=None, prompt=None, extra_pnginfo=None, unique_id=None):
        selected_methods = _recover_selected_methods(selected_methods_json, matting_method, extra_pnginfo, unique_id)
        model_hints = []
        for method in selected_methods:
            try:
                model_hints.append(f"{method}:{_resolve_model_path(method)}")
            except Exception:
                model_hints.append(method)
        batch_shape = tuple(batch_image.shape) if isinstance(batch_image, torch.Tensor) else ()
        image_shape = tuple(image.shape) if isinstance(image, torch.Tensor) else ()
        return f"{batch_shape}|{image_shape}|{selected_methods}|{background}|{device}|{process_res}|{threshold}|{mask_blur}|{invert_output}|{inspyrenet_jit}|{model_hints}"

    def remove_background(
        self,
        matting_method: str = METHOD_RMBG2,
        model_status_json: str = "",
        selected_methods_json: str = "",
        background: str = "透明",
        device: str = "自动",
        process_res: int = MODEL_INPUT_SIZE,
        threshold: float = 0.0,
        mask_blur: float = 0.0,
        invert_output: bool = False,
        inspyrenet_jit: bool = False,
        batch_image: torch.Tensor | None = None,
        image: torch.Tensor | None = None,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        selected_methods = _recover_selected_methods(selected_methods_json, matting_method, extra_pnginfo, unique_id)
        method = selected_methods[0]
        if method not in METHODS:
            method = METHOD_RMBG2
        target_device = _select_device(device)
        torch.set_float32_matmul_precision("high")

        pil_images = _collect_input_images(batch_image, image)
        combined_batches: list[torch.Tensor] = []

        for method in METHODS:
            if method not in selected_methods:
                continue

            route_device = target_device
            weight_path = _resolve_model_path(method)

            if method == METHOD_RMBG2:
                model = _load_rmbg2_model(weight_path, route_device)
                masks = _run_torch_mask_model(model, pil_images, route_device, process_res)
                rgba_images = []
                for original, mask in zip(pil_images, masks):
                    rgba, alpha = _make_rgba_and_mask(original, mask)
                    rgba_images.append(rgba)
                masks = [rgba.getchannel("A") for rgba in rgba_images]
            elif method in (METHOD_BIREF_GENERAL, METHOD_BIREF_MATTING):
                model = _load_birefnet_model(method, weight_path, route_device)
                masks = _run_torch_mask_model(model, pil_images, route_device, process_res)
                rgba_images = []
                for original, mask in zip(pil_images, masks):
                    rgba, alpha = _make_rgba_and_mask(original, mask)
                    rgba_images.append(rgba)
                masks = [rgba.getchannel("A") for rgba in rgba_images]
            elif method == METHOD_BEN2:
                if route_device.type != "cuda":
                    route_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
                model = _load_ben2_model(weight_path, route_device)
                rgba_images, masks = _run_ben2(model, pil_images)
            else:
                rgba_images, masks = _run_inspyrenet(pil_images, weight_path, route_device, threshold, bool(inspyrenet_jit))

            final_rgba: list[Image.Image] = []
            final_masks: list[Image.Image] = []
            for original, rgba, mask in zip(pil_images, rgba_images, masks):
                mask = _postprocess_mask(mask, threshold if method != METHOD_INSPYRENET else 0.0, mask_blur, invert_output)
                new_rgba, new_mask = _make_rgba_and_mask(original, mask)
                final_rgba.append(new_rgba)
                final_masks.append(new_mask)

            image_tensor, mask_tensor = _finish_outputs(final_rgba, final_masks, background)
            image_tensor = image_tensor.contiguous()
            combined_batches.append(image_tensor)

        if combined_batches:
            combined_batch = torch.cat(combined_batches, dim=0).contiguous()
        else:
            combined_batch, _ = _empty_route_output(pil_images, background)

        return (combined_batch,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ComprehensiveMatting}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 批量多功能综合抠图"}
