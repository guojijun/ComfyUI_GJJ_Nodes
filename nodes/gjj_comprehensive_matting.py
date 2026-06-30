from __future__ import annotations

import importlib.util
import json
import sys
import types
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

# ComfyUI 原生依赖（可以安全保留在顶部）
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter
import folder_paths

from .common_utils.dependency_checker import (
    DEFAULT_MODEL_URL,
    build_dependency_model_report,
    load_dependency_at_runtime,
    make_missing_model_spec,
    raise_dependency_model_error,
)

NODE_NAME = "GJJ_ComprehensiveMatting"
METHOD_RMBG14 = "RMBG1.4"
METHOD_RMBG2 = "RMBG2"
METHOD_OFFICIAL_BACKGROUND = "官方背景移除"
METHOD_BIREF_GENERAL = "BiRefNet 通用"
METHOD_BIREF_MATTING = "BiRefNet 精细"
METHOD_BEN2 = "BEN2"
METHOD_INSPYRENET = "Inspyrenet"
METHODS = [
    METHOD_RMBG14,
    METHOD_RMBG2,
    METHOD_OFFICIAL_BACKGROUND,
    METHOD_BIREF_GENERAL,
    METHOD_BIREF_MATTING,
    METHOD_BEN2,
    METHOD_INSPYRENET,
]
METHOD_OUTPUT_SUFFIXES = {
    METHOD_RMBG14: "RMBG1.4",
    METHOD_RMBG2: "RMBG2",
    METHOD_OFFICIAL_BACKGROUND: "官方背景移除",
    METHOD_BIREF_GENERAL: "BiRef通用",
    METHOD_BIREF_MATTING: "BiRef精细",
    METHOD_BEN2: "BEN2",
    METHOD_INSPYRENET: "Inspyrenet",
}
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
BACKGROUND_REMOVAL_MODEL_NAME = "birefnet.safetensors"
BACKGROUND_REMOVAL_CATEGORY = "background_removal"

MODEL_INPUT_SIZE = 1024
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

_MODEL_CACHE: dict[tuple[str, str, str], object] = {}
_RMBG2_COMPONENTS: tuple[type, type] | None = None
_BRIA_RMBG_CLASS: type | None = None
_BIREFNET_CLASS: type | None = None
_BEN2_CLASS: type | None = None
_OFFICIAL_BIREFNET_CLASS: type | None = None
_INSPYRENET_REMOVER_CACHE: dict[tuple[str, str, bool], object] = {}
_OFFICIAL_BACKGROUND_CACHE: dict[str, object] = {}

NODE_DISPLAY_NAME = "GJJ · ✂️ 批量多功能综合抠图"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
DEPENDENCY_SPECS = {
    "numpy": {
        "module_name": "numpy",
        "package_name": "numpy",
        "display_name": "numpy",
        "description": "图像数组与遮罩后处理。",
    },
    "torchvision": {
        "module_name": "torchvision",
        "package_name": "torchvision",
        "display_name": "torchvision",
        "description": "图像 resize、tensor 转换与归一化。",
    },
    "safetensors": {
        "module_name": "safetensors.torch",
        "package_name": "safetensors",
        "display_name": "safetensors",
        "description": "加载 RMBG2/BiRefNet safetensors 权重。",
    },
    "timm": {
        "module_name": "timm",
        "package_name": "timm",
        "display_name": "timm",
        "description": "RMBG2/BiRefNet 模型架构依赖。",
    },
    "kornia": {
        "module_name": "kornia",
        "package_name": "kornia",
        "display_name": "kornia",
        "description": "RMBG2/BiRefNet 图像处理依赖。",
    },
    "transparent_background": {
        "module_name": "transparent_background",
        "package_name": "transparent-background",
        "display_name": "transparent-background",
        "description": "Inspyrenet 抠图运行时依赖。",
    },
    "cv2": {
        "module_name": "cv2",
        "package_name": "opencv-python",
        "display_name": "OpenCV (cv2)",
        "description": "BEN2 模型代码读取和后处理图像时需要。",
    },
    "einops": {
        "module_name": "einops",
        "package_name": "einops",
        "display_name": "einops",
        "description": "BEN2 模型结构中的张量维度重排依赖。",
    },
}
BASE_DESCRIPTION = """综合抠图节点：RMBG1.4、RMBG2、BiRefNet 通用/精细、BEN2、Inspyrenet。模型会在 models 下相关目录模糊搜索。

支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO 单输入口，可同时选择多种抠图方式进行对比。

📦 运行时依赖：
  • 基础：numpy
  • RMBG1.4：torchvision
  • RMBG2 / BiRefNet：torchvision、safetensors、timm、kornia
  • BEN2：timm、einops、torchvision、opencv-python
  • Inspyrenet：transparent-background
  • 官方背景移除：ComfyUI 内置背景移除运行时

💡 提示：执行时只检查已选抠图方式需要的依赖和模型。"""


def _is_module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _missing_startup_dependencies() -> list[dict[str, str]]:
    return []


_MISSING_DEPENDENCIES = _missing_startup_dependencies()
_DEPENDENCIES_AVAILABLE = not _MISSING_DEPENDENCIES
_DEPENDENCY_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
    description="综合抠图节点检测到 Python 运行依赖缺失；安装后请重启 ComfyUI。",
    model_download_url=MODEL_DOWNLOAD_URL,
)
DESCRIPTION_TEXT = (
    BASE_DESCRIPTION
    if _DEPENDENCIES_AVAILABLE
    else f"{_DEPENDENCY_REPORT['warning_message']}\n\n{BASE_DESCRIPTION}"
)


def _dependency(key: str, unique_id=None):
    spec = DEPENDENCY_SPECS[key]
    return load_dependency_at_runtime(
        spec["module_name"],
        NODE_DISPLAY_NAME,
        package_name=spec["package_name"],
        description=spec["description"],
        unique_id=unique_id,
    )


def _required_dependency_keys_for_methods(methods: list[str]) -> set[str]:
    required = set()
    if METHOD_RMBG2 in methods or METHOD_BIREF_GENERAL in methods or METHOD_BIREF_MATTING in methods:
        required.update({"safetensors", "timm", "kornia"})
    if METHOD_BEN2 in methods:
        required.update({"timm", "einops", "torchvision", "cv2"})
    if METHOD_INSPYRENET in methods:
        required.add("transparent_background")
    return required


def _check_dependencies_for_methods(methods: list[str], unique_id=None) -> None:
    missing = _missing_dependencies_for_methods(methods)
    if missing:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing,
            install_packages=[spec["package_name"] for spec in missing],
            description="当前选择的抠图分支缺少运行依赖；安装后请重启 ComfyUI。",
            unique_id=unique_id,
            title="GJJ 综合抠图分支运行依赖缺失！",
            model_download_url=MODEL_DOWNLOAD_URL,
        )
    required = _required_dependency_keys_for_methods(methods)
    for key in sorted(required):
        _dependency(key, unique_id=unique_id)


def _missing_dependencies_for_methods(methods: list[str]) -> list[dict[str, str]]:
    required = _required_dependency_keys_for_methods(methods)
    return [
        DEPENDENCY_SPECS[key]
        for key in sorted(required)
        if key in DEPENDENCY_SPECS and not _is_module_available(DEPENDENCY_SPECS[key]["module_name"])
    ]


def _dependency_report_for_methods(methods: list[str]) -> dict[str, Any]:
    missing = _missing_dependencies_for_methods(methods)
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=missing,
        install_packages=[spec["package_name"] for spec in missing],
        description="当前选择的抠图分支缺少运行依赖；安装后请重启 ComfyUI。",
        model_download_url=MODEL_DOWNLOAD_URL,
    )


def _model_spec_for_method(method: str) -> dict[str, str]:
    specs = {
        METHOD_RMBG14: make_missing_model_spec(
            label="RMBG1.4 模型",
            subdir="RMBG",
            filename="rmbg1.4.safetensors",
            description="默认抠图模型。",
        ),
        METHOD_RMBG2: make_missing_model_spec(
            label="RMBG2 模型",
            subdir="RMBG",
            filename="rmbg2.safetensors",
            description="RMBG2 通用背景移除模型。",
        ),
        METHOD_OFFICIAL_BACKGROUND: make_missing_model_spec(
            label="官方背景移除模型",
            subdir="background_removal",
            filename=BACKGROUND_REMOVAL_MODEL_NAME,
            description="ComfyUI 官方 LoadBackgroundRemovalModel + RemoveBackground 使用的 BiRefNet 模型。",
        ),
        METHOD_BIREF_GENERAL: make_missing_model_spec(
            label="BiRefNet 通用模型",
            subdir="BiRefNet",
            filename="General.safetensors",
            description="BiRefNet 通用分割模型。",
        ),
        METHOD_BIREF_MATTING: make_missing_model_spec(
            label="BiRefNet 精细模型",
            subdir="BiRefNet",
            filename="Matting.safetensors",
            description="BiRefNet 精细抠图模型。",
        ),
        METHOD_BEN2: make_missing_model_spec(
            label="BEN2 模型",
            subdir="RMBG/BEN2",
            filename="BEN2_Base.pth",
            description="BEN2 抠图模型；同目录还需要 BEN2.py 代码文件。",
        ),
        METHOD_INSPYRENET: make_missing_model_spec(
            label="InSPyReNet 模型",
            subdir="RMBG",
            filename="InSPyReNet_SwinB.pth",
            description="InSPyReNet 抠图模型。",
        ),
    }
    return specs.get(method, make_missing_model_spec(label=method, filename=method))


def _raise_missing_model(method: str, error: Exception, unique_id=None):
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[_model_spec_for_method(method)],
        description=f"{method} 运行所需模型缺失，请按帮助面板说明放入 models 目录。",
        original_error=str(error),
        unique_id=unique_id,
        title="GJJ 节点模型缺失！",
        model_download_url=MODEL_DOWNLOAD_URL,
    )


@contextmanager
def _force_cpu_tensor_construction():
    patched_names = [
        "linspace",
        "zeros",
        "ones",
        "empty",
        "full",
        "rand",
        "randn",
        "arange",
    ]
    originals: dict[str, object] = {}

    def _wrap_constructor(fn):
        def _wrapped(*args, **kwargs):
            if kwargs.get("device") is None:
                kwargs["device"] = "cpu"
            return fn(*args, **kwargs)

        return _wrapped

    previous_default_device = None
    can_restore_default_device = hasattr(torch, "get_default_device") and hasattr(
        torch, "set_default_device"
    )
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
        node_path = Path(__file__).resolve()
        roots.append(node_path.parents[2] / "models")
        roots.append(node_path.parents[3] / "models")
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


def _filename_has_extension(name: str) -> bool:
    return bool(Path(str(name or "")).suffix)


def _background_removal_filenames() -> list[str]:
    files: list[str] = []
    try:
        files.extend(folder_paths.get_filename_list(BACKGROUND_REMOVAL_CATEGORY))
    except Exception:
        pass
    for root in _candidate_model_roots():
        bg_root = root / BACKGROUND_REMOVAL_CATEGORY
        if not bg_root.exists():
            continue
        for path in bg_root.rglob("*"):
            if path.is_file():
                try:
                    files.append(str(path.relative_to(bg_root)).replace("\\", "/"))
                except Exception:
                    files.append(path.name)
    return sorted(set(str(item).replace("\\", "/") for item in files if _filename_has_extension(str(item))))


def _resolve_background_removal_model_name() -> str:
    files = _background_removal_filenames()
    if BACKGROUND_REMOVAL_MODEL_NAME in files:
        return BACKGROUND_REMOVAL_MODEL_NAME
    for item in files:
        if Path(item).name.lower() == BACKGROUND_REMOVAL_MODEL_NAME:
            return item
    raise RuntimeError(
        f"未找到官方背景移除模型文件：models/background_removal/{BACKGROUND_REMOVAL_MODEL_NAME}"
    )


def _resolve_background_removal_model_path(unique_id=None, notify_missing: bool = False) -> Path:
    try:
        model_name = _resolve_background_removal_model_name()
        try:
            full_path = folder_paths.get_full_path(BACKGROUND_REMOVAL_CATEGORY, model_name)
        except Exception:
            full_path = None
        if full_path:
            return Path(full_path)
        for root in _candidate_model_roots():
            path = root / BACKGROUND_REMOVAL_CATEGORY / model_name
            if path.is_file():
                return path
        raise FileNotFoundError(
            f"models/background_removal/{model_name}"
        )
    except Exception as exc:
        if notify_missing:
            _raise_missing_model(METHOD_OFFICIAL_BACKGROUND, exc, unique_id=unique_id)
        raise


def _display_model_path(path: Path) -> str:
    resolved = path.resolve()
    for root in _candidate_model_roots():
        try:
            relative = resolved.relative_to(root.resolve())
            return str(Path("models") / relative).replace("\\", "/")
        except ValueError:
            continue
    return str(Path("models") / resolved.name).replace("\\", "/")


def _score_model_path(
    path: Path, includes: tuple[str, ...], excludes: tuple[str, ...] = ()
) -> int:
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
            best = max(
                _score_model_path(path, includes, excludes) for includes in include_sets
            )
            if best > -10000:
                candidates.append((best, path))
    if candidates:
        candidates.sort(
            key=lambda item: (-item[0], len(str(item[1])), str(item[1]).lower())
        )
        return candidates[0][1]
    raise RuntimeError(
        f"未找到 {display_name} 模型文件。已在 models 目录下相关目录模糊搜索。"
    )


def _resolve_model_path(method: str, unique_id=None, notify_missing: bool = False) -> Path:
    try:
        if method == METHOD_OFFICIAL_BACKGROUND:
            return _resolve_background_removal_model_path(
                unique_id=unique_id, notify_missing=notify_missing
            )
        if method == METHOD_RMBG14:
            return _find_model_file(
                "RMBG1.4",
                (("rmbg1.4",), ("rmbg-1.4",), ("bria", "rmbg")),
                (".safetensors", ".pth"),
                excludes=("rmbg2", "rmbg-2"),
            )
        if method == METHOD_RMBG2:
            return _find_model_file(
                "RMBG2", (("rmbg2",), ("rmbg-2",)), (".safetensors", ".pth")
            )
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
            return _find_model_file(
                "InSPyReNet", (("inspyrenet",), ("inspyr",), ("isnet",)), (".pth", ".pt")
            )
        raise RuntimeError(f"未知抠图方式：{method}")
    except Exception as exc:
        if notify_missing:
            _raise_missing_model(method, exc, unique_id=unique_id)
        raise


def _method_model_status() -> dict[str, dict[str, str | bool]]:
    status: dict[str, dict[str, str | bool]] = {}
    for method in METHODS:
        dependency_report = _dependency_report_for_methods([method])
        dependency_missing = bool(dependency_report.get("missing_dependencies"))
        dependency_fields = {
            "dependencies_available": not dependency_missing,
            "dependency_warning_message": dependency_report.get("warning_message", "") if dependency_missing else "",
            "dependency_panel_message": dependency_report.get("panel_message", "") if dependency_missing else "",
            "dependency_install_cmd": dependency_report.get("install_cmd", "") if dependency_missing else "",
            "dependency_copy_text": dependency_report.get("copy_text", "") if dependency_missing else "",
            "dependency_copy_label": dependency_report.get("copy_label", "") if dependency_missing else "",
            "dependency_notice_level": dependency_report.get("notice_level", "ok") if dependency_missing else "ok",
        }
        try:
            path = _resolve_model_path(method)
            display_path = _display_model_path(path)
            status[method] = {
                "available": True,
                "model_name": path.name,
                "model_path": display_path,
                **dependency_fields,
            }
        except Exception:
            status[method] = {
                "available": False,
                "model_name": "未找到",
                "model_path": "",
                **dependency_fields,
                "message": (
                    f"请放入 models/background_removal/{BACKGROUND_REMOVAL_MODEL_NAME}。"
                    if method == METHOD_OFFICIAL_BACKGROUND
                    else "已在 models 下相关目录模糊搜索，但没有匹配文件。"
                ),
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
            if item.get("dependency_warning_message"):
                lines.append(f"  依赖：{item.get('dependency_warning_message')}")
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
    np = _dependency("numpy")
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    return [
        Image.fromarray(
            np.clip(255.0 * tensor[index].cpu().numpy(), 0, 255).astype(np.uint8)
        )
        for index in range(tensor.shape[0])
    ]


def _pil_list_to_tensor(images: list[Image.Image]) -> torch.Tensor:
    np = _dependency("numpy")
    tensors = []
    for image in images:
        array = np.array(image, dtype=np.float32) / 255.0
        if array.ndim == 2:
            array = array[:, :, None]
        tensors.append(torch.from_numpy(array))
    return torch.stack(tensors, dim=0)


def _mask_tensor_to_pil_list(mask_tensor: torch.Tensor) -> list[Image.Image]:
    np = _dependency("numpy")
    tensor = mask_tensor.detach().float().cpu()
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim == 4:
        if tensor.shape[1] == 1:
            tensor = tensor[:, 0]
        elif tensor.shape[-1] == 1:
            tensor = tensor[..., 0]
        else:
            tensor = tensor[:, 0]
    if tensor.ndim != 3:
        raise RuntimeError(f"官方背景移除输出遮罩格式无效：{tuple(mask_tensor.shape)}。")
    return [
        Image.fromarray(np.clip(255.0 * tensor[index].numpy(), 0, 255).astype(np.uint8), mode="L")
        for index in range(tensor.shape[0])
    ]


def _normalize_state_dict_keys(
    state_dict: dict[str, torch.Tensor],
) -> dict[str, torch.Tensor]:
    if state_dict and all(key.startswith("module.") for key in state_dict):
        return {key[7:]: value for key, value in state_dict.items()}
    return state_dict


def _load_python_module(module_name: str, file_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, str(file_path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 Python 模块：{file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_rmbg2_components() -> tuple[type, type]:
    global _RMBG2_COMPONENTS
    if _RMBG2_COMPONENTS is not None:
        return _RMBG2_COMPONENTS

    model_root = Path(__file__).resolve().parent / "common_utils" / "rmbg2_model"
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


def _load_bria_rmbg_class() -> type:
    global _BRIA_RMBG_CLASS
    if _BRIA_RMBG_CLASS is not None:
        return _BRIA_RMBG_CLASS
    from .common_utils.briarmbg_model import BriaRMBG

    _BRIA_RMBG_CLASS = BriaRMBG
    return _BRIA_RMBG_CLASS


def _load_ben2_class(unique_id=None) -> type:
    global _BEN2_CLASS
    if _BEN2_CLASS is not None:
        return _BEN2_CLASS

    try:
        model_code = _find_model_file("BEN2.py", (("ben2",),), (".py",))
    except Exception as exc:
        _raise_missing_model(METHOD_BEN2, exc, unique_id=unique_id)
    module_name = "gjj_ben2_model"
    spec = importlib.util.spec_from_file_location(module_name, str(model_code))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 BEN2 模型代码：{model_code}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except ModuleNotFoundError as exc:
        missing_name = str(getattr(exc, "name", "") or "").strip()
        if missing_name in DEPENDENCY_SPECS:
            dep = DEPENDENCY_SPECS[missing_name]
        else:
            dep = {
                "module_name": missing_name or "unknown",
                "package_name": missing_name or "unknown",
                "display_name": missing_name or "unknown",
                "description": f"BEN2 模型代码导入时需要 {missing_name or '该依赖'}。",
            }
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[dep],
            install_packages=[dep.get("package_name") or dep.get("module_name")],
            description="BEN2 分支缺少运行依赖；安装后请重启 ComfyUI。",
            original_error=str(exc),
            unique_id=unique_id,
            title="GJJ BEN2 分支运行依赖缺失！",
            model_download_url=MODEL_DOWNLOAD_URL,
        )
    _BEN2_CLASS = module.BEN_Base
    return _BEN2_CLASS


def _load_rmbg2_model(weight_path: Path, device: torch.device, unique_id=None) -> torch.nn.Module:
    cache_key = (METHOD_RMBG2, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    _dependency("timm", unique_id=unique_id)
    _dependency("kornia", unique_id=unique_id)
    BiRefNetConfig, BiRefNet = _load_rmbg2_components()
    safetensors_torch = _dependency("safetensors", unique_id=unique_id)
    with _force_cpu_tensor_construction():
        model = BiRefNet(
            bb_pretrained=False, config=BiRefNetConfig(bb_pretrained=False)
        )
        state_dict = (
            safetensors_torch.load_file(str(weight_path), device="cpu")
            if weight_path.suffix == ".safetensors"
            else torch.load(str(weight_path), map_location="cpu")
        )
        model.load_state_dict(_normalize_state_dict_keys(state_dict), strict=True)

    target_dtype = torch.float16 if device.type == "cuda" else torch.float32
    model.to(device=device, dtype=target_dtype)
    model.eval()
    _MODEL_CACHE[cache_key] = model
    return model


def _load_rmbg14_model(weight_path: Path, device: torch.device) -> torch.nn.Module:
    cache_key = (METHOD_RMBG14, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    BriaRMBG = _load_bria_rmbg_class()
    model = BriaRMBG()
    if weight_path.suffix == ".safetensors":
        safetensors_torch = _dependency("safetensors")
        state_dict = safetensors_torch.load_file(str(weight_path), device="cpu")
    else:
        state_dict = torch.load(str(weight_path), map_location="cpu", weights_only=False)
    model.load_state_dict(_normalize_state_dict_keys(state_dict), strict=True)
    model.to(device=device, dtype=torch.float32)
    model.eval()
    _MODEL_CACHE[cache_key] = model
    return model


def _load_birefnet_model(
    method: str, weight_path: Path, device: torch.device, unique_id=None
) -> torch.nn.Module:
    cache_key = (method, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    _dependency("timm", unique_id=unique_id)
    _dependency("kornia", unique_id=unique_id)
    BiRefNet = _load_birefnet_class()
    safetensors_torch = _dependency("safetensors", unique_id=unique_id)
    with _force_cpu_tensor_construction():
        model = BiRefNet(bb_pretrained=False, bb_index=6)
        state_dict = (
            safetensors_torch.load_file(str(weight_path), device="cpu")
            if weight_path.suffix == ".safetensors"
            else torch.load(str(weight_path), map_location="cpu")
        )
        model.load_state_dict(_normalize_state_dict_keys(state_dict), strict=True)

    target_dtype = torch.float16 if device.type == "cuda" else torch.float32
    model.to(device=device, dtype=target_dtype)
    model.eval()
    _MODEL_CACHE[cache_key] = model
    return model


def _load_ben2_model(weight_path: Path, device: torch.device, unique_id=None) -> torch.nn.Module:
    cache_key = (METHOD_BEN2, str(weight_path), str(device))
    cached_model = _MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model  # type: ignore[return-value]

    BEN_Base = _load_ben2_class(unique_id=unique_id)
    model = BEN_Base().to(device).eval()
    model.loadcheckpoints(str(weight_path))
    _MODEL_CACHE[cache_key] = model
    return model


def _load_official_birefnet_class() -> type:
    global _OFFICIAL_BIREFNET_CLASS
    if _OFFICIAL_BIREFNET_CLASS is not None:
        return _OFFICIAL_BIREFNET_CLASS
    module_path = Path(__file__).resolve().parent / "common_utils" / "background_removal" / "birefnet.py"
    module = _load_python_module("gjj_official_background_removal_birefnet", module_path)
    _OFFICIAL_BIREFNET_CLASS = module.BiRefNet
    return _OFFICIAL_BIREFNET_CLASS


class _GJJBackgroundRemovalModel:
    def __init__(self):
        import comfy.clip_model
        import comfy.model_management
        import comfy.model_patcher
        import comfy.ops

        config_path = Path(__file__).resolve().parent / "common_utils" / "background_removal" / "birefnet.json"
        with open(config_path, "r", encoding="utf-8") as handle:
            config = json.load(handle)

        self.image_size = int(config.get("image_size", 1024))
        self.image_mean = config.get("image_mean", [0.0, 0.0, 0.0])
        self.image_std = config.get("image_std", [1.0, 1.0, 1.0])
        self.load_device = comfy.model_management.text_encoder_device()
        offload_device = comfy.model_management.text_encoder_offload_device()
        self.dtype = torch.float32
        model_class = _load_official_birefnet_class()
        self.model = model_class(config, self.dtype, offload_device, comfy.ops.disable_weight_init)
        self.model.eval()
        self.patcher = comfy.model_patcher.CoreModelPatcher(
            self.model,
            load_device=self.load_device,
            offload_device=offload_device,
        )

    def load_sd(self, state_dict: dict[str, torch.Tensor]):
        try:
            return self.model.load_state_dict(state_dict, strict=False, assign=self.patcher.is_dynamic())
        except TypeError:
            return self.model.load_state_dict(state_dict, strict=False)

    def inference_device_dtype(self) -> tuple[torch.device, torch.dtype]:
        for tensor in self.model.parameters():
            if tensor.is_floating_point():
                return tensor.device, torch.float32
        return torch.device(self.load_device), self.dtype

    def encode_image(self, image: torch.Tensor) -> torch.Tensor:
        import comfy.clip_model
        import comfy.model_management

        comfy.model_management.load_model_gpu(self.patcher)
        target_device, target_dtype = self.inference_device_dtype()
        self.model.to(device=target_device, dtype=target_dtype)
        height, width = image.shape[1], image.shape[2]
        pixel_values = comfy.clip_model.clip_preprocess(
            image.to(target_device),
            size=self.image_size,
            mean=self.image_mean,
            std=self.image_std,
            crop=False,
        ).to(device=target_device, dtype=target_dtype)
        if pixel_values.shape[0] > 1:
            out = torch.cat(
                [self.model(pixel_values=pixel_values[index:index + 1]) for index in range(pixel_values.shape[0])],
                dim=0,
            )
        else:
            out = self.model(pixel_values=pixel_values)
        out = F.interpolate(out, size=(height, width), mode="bicubic", antialias=False)
        mask = out.sigmoid().to(
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        return mask.squeeze(1)


def _load_official_background_model_fallback(weight_path: Path):
    from comfy.utils import load_torch_file

    state_dict = load_torch_file(str(weight_path))
    if "bb.layers.1.blocks.0.attn.relative_position_index" not in state_dict:
        return None
    model = _GJJBackgroundRemovalModel()
    missing, unexpected = model.load_sd(state_dict)
    unexpected = set(unexpected)
    for key in list(state_dict.keys()):
        if key not in unexpected:
            state_dict.pop(key, None)
    return model


def _load_official_background_model(weight_path: Path):
    cache_key = str(weight_path)
    cached_model = _OFFICIAL_BACKGROUND_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model
    try:
        from comfy.bg_removal_model import load as load_background_removal_model

        model = load_background_removal_model(str(weight_path))
    except ModuleNotFoundError:
        model = _load_official_background_model_fallback(weight_path)
    if model is None:
        raise RuntimeError(
            f"官方背景移除模型无效：{_display_model_path(weight_path)}。请确认文件是 BiRefNet background_removal 权重。"
        )
    _OFFICIAL_BACKGROUND_CACHE[cache_key] = model
    return model


def _make_rgba_and_mask(
    original: Image.Image, mask: Image.Image
) -> tuple[Image.Image, Image.Image]:
    mask = mask.convert("L")
    rgba = original.convert("RGBA")
    rgba.putalpha(mask)
    return rgba, mask


def _finish_outputs(
    rgba_images: list[Image.Image], masks: list[Image.Image], background: str
) -> tuple[torch.Tensor, torch.Tensor]:
    if background in ("transparent", "透明"):
        image_tensor = _pil_list_to_tensor(
            [item.convert("RGBA") for item in rgba_images]
        )
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


def _save_rgba_preview(rgba_images: list[Image.Image]) -> list[dict[str, Any]]:
    if not rgba_images:
        return []
    try:
        target_dir = Path(folder_paths.get_temp_directory()) / "GJJ" / "comprehensive_matting_preview"
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"GJJ_ComprehensiveMatting_{uuid.uuid4().hex[:12]}.png"
        path = target_dir / filename
        image = rgba_images[0].convert("RGBA")
        image.save(path, format="PNG")
        return [{
            "filename": filename,
            "subfolder": "GJJ/comprehensive_matting_preview",
            "type": "temp",
            "format": "image/png",
            "media_type": "image",
            "width": int(image.width),
            "height": int(image.height),
        }]
    except Exception as exc:
        print(f"[GJJ_ComprehensiveMatting] RGBA 预览保存失败: {exc}")
        return []


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_media_tensor(value: Any) -> torch.Tensor | None:
    source = value
    if source is None:
        return None
    if hasattr(source, "get_components"):
        try:
            source = source.get_components()
        except Exception as exc:
            raise RuntimeError(f"综合抠图读取 VIDEO 帧失败：{exc}") from exc
        source = _component_value(source, "images")
        if source is None:
            raise RuntimeError("综合抠图收到的 VIDEO 没有解析出可用图片帧。")
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    if isinstance(source, torch.Tensor):
        tensor = source
    elif isinstance(source, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(source, (list, tuple)) and source and all(isinstance(item, torch.Tensor) for item in source):
        tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in source], dim=0)
    else:
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    if tensor is None:
        return None
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(
            f"综合抠图收到的媒体帧格式不正确，应为 IMAGE / GJJ_BATCH_IMAGE / VIDEO，实际为 {tuple(tensor.shape)}。"
        )
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels not in (3, 4):
        raise RuntimeError(f"综合抠图收到的媒体通道数无效：{tuple(tensor.shape)}。")
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


def _collect_input_images(media: Any | None) -> list[Image.Image]:
    tensor = _coerce_media_tensor(media)
    images: list[Image.Image] = []
    if tensor is not None:
        images.extend(_tensor_to_pil_list(tensor))
    if not images:
        raise RuntimeError("综合抠图至少需要连接 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO。")
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
            selected = [
                item.strip() for item in text.split(",") if item.strip() in METHODS
            ]
    if not selected:
        selected = [fallback if fallback in METHODS else METHOD_RMBG14]

    ordered: list[str] = []
    for method in METHODS:
        if method in selected and method not in ordered:
            ordered.append(method)
    return ordered or [METHOD_RMBG14]


def _recover_selected_methods(
    raw_value: str, fallback: str, extra_pnginfo: Any = None, unique_id: Any = None
) -> list[str]:
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


def _empty_route_output(
    reference: list[Image.Image], background: str
) -> tuple[torch.Tensor, torch.Tensor]:
    width, height = reference[0].size if reference else (64, 64)
    alpha = Image.new("L", (width, height), 0)
    rgba = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image_tensor, mask_tensor = _finish_outputs([rgba], [alpha], background)
    return image_tensor.contiguous(), mask_tensor


def _postprocess_mask(
    mask: Image.Image, threshold: float, blur: float, invert: bool
) -> Image.Image:
    np = _dependency("numpy")
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
    transforms = _dependency("torchvision").transforms
    from torchvision.transforms.functional import to_pil_image

    input_size = max(64, int(process_res or MODEL_INPUT_SIZE))
    preprocess = transforms.Compose(
        [
            transforms.Resize((input_size, input_size)),
            transforms.ToTensor(),
            transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
        ]
    )
    input_images = torch.stack([preprocess(item.convert("RGB")) for item in images]).to(
        device
    )
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


def _run_rmbg14(
    model: torch.nn.Module,
    images: list[Image.Image],
    device: torch.device,
    process_res: int,
) -> list[Image.Image]:
    np = _dependency("numpy")

    input_size = max(64, int(process_res or MODEL_INPUT_SIZE))
    resample_lanczos = getattr(
        getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS
    )
    tensors = []
    for image in images:
        resized = image.convert("RGB").resize((input_size, input_size), resample_lanczos)
        array = np.array(resized, dtype=np.float32)
        tensor = torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0) / 255.0
        mean = torch.tensor([0.5, 0.5, 0.5], dtype=tensor.dtype).view(1, 3, 1, 1)
        tensor = tensor - mean
        tensors.append(tensor.squeeze(0))
    input_images = torch.stack(tensors, dim=0).to(device=device, dtype=torch.float32)

    with torch.inference_mode():
        predictions = model(input_images)[0][0].float().cpu()
    del input_images

    masks: list[Image.Image] = []
    for original, prediction in zip(images, predictions):
        if prediction.ndim == 2:
            prediction = prediction.unsqueeze(0).unsqueeze(0)
        elif prediction.ndim == 3:
            prediction = prediction.unsqueeze(0)
        elif prediction.ndim != 4:
            raise RuntimeError(
                f"RMBG1.4 输出遮罩维度异常：{tuple(prediction.shape)}"
            )
        resized = F.interpolate(
            prediction,
            size=(original.height, original.width),
            mode="bilinear",
            align_corners=False,
        ).squeeze()
        min_value = torch.min(resized)
        max_value = torch.max(resized)
        if float(max_value - min_value) > 1e-6:
            resized = (resized - min_value) / (max_value - min_value)
        array = np.clip(255.0 * resized.clamp(0, 1).numpy(), 0, 255).astype(np.uint8)
        masks.append(Image.fromarray(array, mode="L"))
    return masks


def _run_ben2(
    model: torch.nn.Module, images: list[Image.Image]
) -> tuple[list[Image.Image], list[Image.Image]]:
    np = _dependency("numpy")
    rgba_images: list[Image.Image] = []
    masks: list[Image.Image] = []
    resample_lanczos = getattr(
        getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS
    )
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
    unique_id=None,
) -> tuple[list[Image.Image], list[Image.Image]]:
    Remover = _dependency("transparent_background", unique_id=unique_id).Remover
    cache_key = (str(weight_path), str(device), bool(jit))
    remover = _INSPYRENET_REMOVER_CACHE.get(cache_key)
    if remover is None:
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


# ═══════════════════════════════════════════════
# 节点类定义
# ═══════════════════════════════════════════════
class GJJ_ComprehensiveMatting:
    CATEGORY = "GJJ"
    FUNCTION = "remove_background"
    SEARCH_ALIASES = [
        "rmbg",
        "remove background",
        "抠图",
        "去背景",
        "背景移除",
        "前景提取",
        "birefnet",
        "ben2",
        "inspyrenet",
    ]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "遮罩")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "把所有已选路线的结果按路线顺序合并成一个 ComfyUI 原生 IMAGE batch 输出，可直接连接预览、保存和普通 IMAGE 节点。",
        "把所有已选路线生成的前景遮罩按路线顺序合并成 MASK batch 输出，可连接遮罩预览、合成或后续修边节点。",
    )

    DESCRIPTION = DESCRIPTION_TEXT

    GJJ_HELP = {
        "notice": _DEPENDENCY_REPORT["help_message"] if not _DEPENDENCIES_AVAILABLE else "",
        "install_cmd": _DEPENDENCY_REPORT["install_cmd"] if not _DEPENDENCIES_AVAILABLE else "",
        "copy_text": _DEPENDENCY_REPORT["copy_text"] if not _DEPENDENCIES_AVAILABLE else "",
        "copy_label": _DEPENDENCY_REPORT["copy_label"] if not _DEPENDENCIES_AVAILABLE else "",
        "warning_message": _DEPENDENCY_REPORT["warning_message"] if not _DEPENDENCIES_AVAILABLE else "",
        "model_status": _method_model_status(),
        "models": [
            {
                "label": "🔴官方背景移除模型",
                "path": f"models/background_removal/{BACKGROUND_REMOVAL_MODEL_NAME}",
                "folder": "background_removal",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘ComfyUI 官方 LoadBackgroundRemovalModel + RemoveBackground 使用的 BiRefNet 模型；模型树只显示带扩展名的模型文件。",
            },
            {
                "label": "🟣RMBG1.4 模型",
                "path": "models/RMBG/rmbg1.4.safetensors",
                "folder": "RMBG",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘RMBG1.4 默认抠图模型；默认读取 models/RMBG/rmbg1.4.safetensors，也会模糊搜索 rmbg1.4 相关 pth 文件。",
            },
            {
                "label": "🟣RMBG2 模型",
                "path": "models/RMBG/rmbg2.safetensors",
                "folder": "RMBG",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘RMBG2 抠图模型；会在 models 目录下搜索 rmbg2 或 rmbg-2 相关文件。",
            },
            {
                "label": "🟢BiRefNet 通用模型",
                "path": "models/BiRefNet/General.safetensors",
                "folder": "BiRefNet",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘BiRefNet 通用分割模型；会搜索包含 general 的 birefnet 模型文件。",
            },
            {
                "label": "🟢BiRefNet 精细模型",
                "path": "models/BiRefNet/Matting.safetensors",
                "folder": "BiRefNet",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘BiRefNet 精细抠图模型；会搜索包含 matting 的 birefnet 模型文件。",
            },
            {
                "label": "🟡BEN2 模型",
                "path": "models/RMBG/BEN2/BEN2_Base.pth",
                "folder": "RMBG",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘BEN2 抠图模型；会搜索 ben2 相关的 pth 文件，需要同时存在 BEN2.py 代码文件。",
            },
            {
                "label": "🔵InSPyReNet 模型",
                "path": "models/RMBG/InSPyReNet_SwinB.pth",
                "folder": "RMBG",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "📘InSPyReNet 抠图模型；会搜索 inspyrenet 或 isnet 相关的 pth/pt 文件。",
            },
        ],
        "dependencies": [
            "基础：numpy",
            "RMBG1.4：torchvision",
            "RMBG2 / BiRefNet：torchvision、safetensors、timm、kornia",
            "BEN2：timm、einops、torchvision、opencv-python",
            "Inspyrenet：transparent-background",
            "官方背景移除：ComfyUI 内置背景移除运行时 + models/background_removal/birefnet.safetensors",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        method_status = _method_model_status()
        return {
            "required": {
                "matting_method": (
                    METHODS,
                    {
                        "default": METHOD_RMBG14,
                        "display_name": "抠图方式",
                        "tooltip": _method_tooltip_text(method_status),
                        "hidden": True,
                        "display": "hidden",
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
                        "tooltip": "RMBG1.4/RMBG2/BiRefNet 的内部推理分辨率。",
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
                "media": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "图片/视频",
                        "tooltip": "统一输入口，支持 GJJ_BATCH_IMAGE、普通 IMAGE/IMAGE batch 和官方 VIDEO；接 VIDEO 时自动读取视频帧。",
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
    def IS_CHANGED(
        cls,
        matting_method,
        background,
        device,
        process_res,
        threshold,
        mask_blur,
        invert_output,
        inspyrenet_jit,
        media=None,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        selected_methods = _recover_selected_methods(
            "", matting_method, extra_pnginfo, unique_id
        )
        model_hints = []
        for method in selected_methods:
            try:
                model_hints.append(f"{method}:{_resolve_model_path(method)}")
            except Exception:
                model_hints.append(method)
        media_tensor = _coerce_media_tensor(media)
        media_shape = tuple(media_tensor.shape) if isinstance(media_tensor, torch.Tensor) else ()
        return f"{media_shape}|{selected_methods}|{background}|{device}|{process_res}|{threshold}|{mask_blur}|{invert_output}|{inspyrenet_jit}|{model_hints}"

    def remove_background(
        self,
        matting_method: str = METHOD_RMBG14,
        background: str = "透明",
        device: str = "自动",
        process_res: int = MODEL_INPUT_SIZE,
        threshold: float = 0.0,
        mask_blur: float = 0.0,
        invert_output: bool = False,
        inspyrenet_jit: bool = False,
        media=None,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        selected_methods = _recover_selected_methods(
            "", matting_method, extra_pnginfo, unique_id
        )
        _check_dependencies_for_methods(selected_methods, unique_id=unique_id)
        method = selected_methods[0]
        if method not in METHODS:
            method = METHOD_RMBG14
        target_device = _select_device(device)
        torch.set_float32_matmul_precision("high")

        pil_images = _collect_input_images(media)
        combined_batches: list[torch.Tensor] = []
        combined_masks: list[torch.Tensor] = []
        preview_rgba: list[Image.Image] = []

        for method in METHODS:
            if method not in selected_methods:
                continue

            route_device = target_device
            weight_path = _resolve_model_path(
                method, unique_id=unique_id, notify_missing=True
            )

            if method == METHOD_RMBG14:
                model = _load_rmbg14_model(weight_path, route_device)
                masks = _run_rmbg14(
                    model, pil_images, route_device, process_res
                )
                rgba_images = []
                for original, mask in zip(pil_images, masks):
                    rgba, alpha = _make_rgba_and_mask(original, mask)
                    rgba_images.append(rgba)
                masks = [rgba.getchannel("A") for rgba in rgba_images]
            elif method == METHOD_RMBG2:
                model = _load_rmbg2_model(weight_path, route_device, unique_id=unique_id)
                masks = _run_torch_mask_model(
                    model, pil_images, route_device, process_res
                )
                rgba_images = []
                for original, mask in zip(pil_images, masks):
                    rgba, alpha = _make_rgba_and_mask(original, mask)
                    rgba_images.append(rgba)
                masks = [rgba.getchannel("A") for rgba in rgba_images]
            elif method == METHOD_OFFICIAL_BACKGROUND:
                model = _load_official_background_model(weight_path)
                input_tensor = _pil_list_to_tensor([image.convert("RGB") for image in pil_images])
                masks = _mask_tensor_to_pil_list(model.encode_image(input_tensor))
                rgba_images = []
                for original, mask in zip(pil_images, masks):
                    rgba, alpha = _make_rgba_and_mask(original, mask)
                    rgba_images.append(rgba)
                masks = [rgba.getchannel("A") for rgba in rgba_images]
            elif method in (METHOD_BIREF_GENERAL, METHOD_BIREF_MATTING):
                model = _load_birefnet_model(
                    method, weight_path, route_device, unique_id=unique_id
                )
                masks = _run_torch_mask_model(
                    model, pil_images, route_device, process_res
                )
                rgba_images = []
                for original, mask in zip(pil_images, masks):
                    rgba, alpha = _make_rgba_and_mask(original, mask)
                    rgba_images.append(rgba)
                masks = [rgba.getchannel("A") for rgba in rgba_images]
            elif method == METHOD_BEN2:
                if route_device.type != "cuda":
                    route_device = torch.device(
                        "cuda" if torch.cuda.is_available() else "cpu"
                    )
                model = _load_ben2_model(weight_path, route_device, unique_id=unique_id)
                rgba_images, masks = _run_ben2(model, pil_images)
            else:
                rgba_images, masks = _run_inspyrenet(
                    pil_images,
                    weight_path,
                    route_device,
                    threshold,
                    bool(inspyrenet_jit),
                    unique_id,
                )

            final_rgba: list[Image.Image] = []
            final_masks: list[Image.Image] = []
            for original, rgba, mask in zip(pil_images, rgba_images, masks):
                mask = _postprocess_mask(
                    mask,
                    threshold if method != METHOD_INSPYRENET else 0.0,
                    mask_blur,
                    invert_output,
                )
                new_rgba, new_mask = _make_rgba_and_mask(original, mask)
                final_rgba.append(new_rgba)
                final_masks.append(new_mask)

            image_tensor, mask_tensor = _finish_outputs(
                final_rgba, final_masks, background
            )
            image_tensor = image_tensor.contiguous()
            mask_tensor = mask_tensor.contiguous()
            combined_batches.append(image_tensor)
            combined_masks.append(mask_tensor)
            if final_rgba and not preview_rgba:
                preview_rgba.append(final_rgba[0])

        if combined_batches:
            combined_batch = torch.cat(combined_batches, dim=0).contiguous()
            combined_mask = torch.cat(combined_masks, dim=0).contiguous()
        else:
            combined_batch, combined_mask = _empty_route_output(pil_images, background)

        return {
            "ui": {"rgba_preview": _save_rgba_preview(preview_rgba)},
            "result": (combined_batch, combined_mask),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ComprehensiveMatting}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 批量多功能综合抠图"}
