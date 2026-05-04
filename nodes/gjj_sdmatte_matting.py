from __future__ import annotations

import gc
import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from torch.hub import download_url_to_file
from torchvision import transforms
from torchvision.transforms import InterpolationMode

import comfy.model_management
import folder_paths

try:
    from safetensors.torch import load_file
except Exception as exc:  # pragma: no cover - ComfyUI normally ships safetensors.
    load_file = None
    _SAFETENSORS_IMPORT_ERROR = exc
else:
    _SAFETENSORS_IMPORT_ERROR = None


NODE_NAME = "GJJ_SDMatteMatting"
SDMATTE_COMPONENTS = ("scheduler", "text_encoder", "tokenizer", "unet", "vae")
SDMATTE_MODELS = {
    "SDMatte": {
        "filename": "SDMatte.safetensors",
        "url": "https://huggingface.co/1038lab/SDMatte/resolve/main/SDMatte.safetensors",
        "repo": "1038lab/SDMatte",
    },
    "SDMatte_plus": {
        "filename": "SDMatte_plus.safetensors",
        "url": "https://huggingface.co/1038lab/SDMatte/resolve/main/SDMatte_plus.safetensors",
        "repo": "1038lab/SDMatte",
    },
}

_MODEL_CACHE: dict[tuple[str, str], torch.nn.Module] = {}
_SDMATTE_CLASS = None


def _candidate_models_dirs() -> list[Path]:
    dirs: list[Path] = []
    gjj_mod_models = Path(__file__).resolve().parents[3] / "models"
    if gjj_mod_models.exists():
        dirs.append(gjj_mod_models)
    comfy_models = Path(folder_paths.models_dir)
    if comfy_models not in dirs:
        dirs.append(comfy_models)
    return dirs


def _models_root(base: Path | None = None) -> Path:
    return (base or _candidate_models_dirs()[0]) / "RMBG" / "SDMatte"


def _component_files(component: str) -> list[str]:
    if component == "scheduler":
        return ["scheduler_config.json"]
    if component == "text_encoder":
        return ["config.json"]
    if component == "tokenizer":
        return ["merges.txt", "special_tokens_map.json", "tokenizer_config.json", "vocab.json"]
    if component == "unet":
        return ["config.json"]
    if component == "vae":
        return ["config.json"]
    return []


def _download_file(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        download_url_to_file(url, str(target))
    except Exception as exc:
        raise RuntimeError(f"下载 SDMatte 文件失败：{url}\n目标路径：{target}\n原因：{exc}") from exc


def _resolve_weight(model_name: str) -> Path:
    info = SDMATTE_MODELS[model_name]
    candidates = []
    for base in _candidate_models_dirs():
        candidates.extend([base / "RMBG" / "SDMatte" / info["filename"], base / "RMBG" / info["filename"], base / "ckpts" / info["filename"]])
    for path in candidates:
        if path.exists():
            return path

    target = candidates[0]
    _download_file(info["url"], target)
    return target


def _ensure_components(model_name: str) -> Path:
    for base in _candidate_models_dirs():
        root = _models_root(base)
        if all((root / component / filename).exists() for component in SDMATTE_COMPONENTS for filename in _component_files(component)):
            return root

    root = _models_root()
    repo = SDMATTE_MODELS[model_name]["repo"]
    base_url = f"https://huggingface.co/{repo}/resolve/main"

    for component in SDMATTE_COMPONENTS:
        component_dir = root / component
        for filename in _component_files(component):
            file_path = component_dir / filename
            if not file_path.exists():
                _download_file(f"{base_url}/{component}/{filename}", file_path)
    return root


def _load_sdmatte_class():
    global _SDMATTE_CLASS
    if _SDMATTE_CLASS is not None:
        return _SDMATTE_CLASS
    try:
        from ..vendor.sdmatte.modeling.SDMatte.meta_arch import SDMatte
    except Exception as exc:
        raise RuntimeError(f"加载 GJJ 内置 SDMatte 运行时代码失败：{exc}") from exc
    _SDMATTE_CLASS = SDMatte
    return _SDMATTE_CLASS


def _device_from_choice(choice: str) -> torch.device:
    if choice == "CPU":
        return torch.device("cpu")
    if choice == "GPU":
        if not torch.cuda.is_available():
            raise RuntimeError("已选择 GPU，但当前 PyTorch 没有可用 CUDA。")
        return comfy.model_management.get_torch_device()
    return comfy.model_management.get_torch_device() if torch.cuda.is_available() else torch.device("cpu")


def _load_model(model_name: str, device_choice: str) -> torch.nn.Module:
    if load_file is None:
        raise RuntimeError(f"当前环境缺少 safetensors，无法加载 SDMatte 权重：{_SAFETENSORS_IMPORT_ERROR}")

    device = _device_from_choice(device_choice)
    weight_path = _resolve_weight(model_name)
    components_dir = _ensure_components(model_name)
    cache_key = (str(weight_path), str(device))
    cached = _MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        SDMatte = _load_sdmatte_class()
        model = SDMatte(
            pretrained_model_name_or_path=str(components_dir),
            load_weight=False,
            use_aux_input=True,
            aux_input="trimap",
            use_encoder_hidden_states=True,
            use_attention_mask=True,
            add_noise=False,
        )
    except Exception as exc:
        raise RuntimeError(
            "初始化 SDMatte 模型失败。请确认当前 ComfyUI 环境已安装 diffusers 与 transformers，"
            f"并且组件目录完整：{components_dir}\n原因：{exc}"
        ) from exc

    try:
        state_dict = load_file(str(weight_path), device="cpu")
        model.load_state_dict(state_dict, strict=False)
    except Exception as exc:
        raise RuntimeError(f"加载 SDMatte 权重失败：{weight_path}\n原因：{exc}") from exc

    model.eval()
    model.to(device)
    _MODEL_CACHE[cache_key] = model
    return model


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    array = np.clip(255.0 * image.detach().cpu().numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(array)


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def _resize_norm_image_bchw(image_bchw: torch.Tensor, size: int) -> torch.Tensor:
    if image_bchw.shape[1] == 4:
        image_bchw = image_bchw[:, :3, :, :]
    resize = transforms.Resize((size, size), interpolation=InterpolationMode.BILINEAR, antialias=True)
    norm = transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5])
    return norm(resize(image_bchw))


def _resize_mask_b1hw(mask_b1hw: torch.Tensor, size: int) -> torch.Tensor:
    resize = transforms.Resize((size, size), interpolation=InterpolationMode.BILINEAR, antialias=True)
    return resize(mask_b1hw)


def _process_mask(mask_image: Image.Image, invert: bool, blur: int, offset: int) -> Image.Image:
    if invert:
        mask_image = Image.fromarray(255 - np.array(mask_image))
    if blur > 0:
        mask_image = mask_image.filter(ImageFilter.GaussianBlur(radius=blur))
    if offset != 0:
        filter_type = ImageFilter.MaxFilter if offset > 0 else ImageFilter.MinFilter
        size = abs(offset) * 2 + 1
        for _ in range(abs(offset)):
            mask_image = mask_image.filter(filter_type(size))
    return mask_image


def _parse_hex_color(value: str) -> tuple[int, int, int, int]:
    text = str(value or "#222222").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        raise ValueError("背景颜色必须是 #RRGGBB 格式，例如 #222222。")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16), 255


def _apply_background(image: Image.Image, mask_image: Image.Image, background: str, color: str) -> Image.Image:
    rgba = image.copy().convert("RGBA")
    rgba.putalpha(mask_image.convert("L"))
    if background == "纯色":
        canvas = Image.new("RGBA", image.size, _parse_hex_color(color))
        return Image.alpha_composite(canvas, rgba).convert("RGB")
    return rgba


def _refine_mask(mask: torch.Tensor, trimap: torch.Tensor, sensitivity: float) -> torch.Tensor:
    trimap_cpu = trimap.detach().cpu()
    foreground = trimap_cpu > sensitivity
    background = trimap_cpu < (1.0 - sensitivity)
    unknown = ~(foreground | background)

    refined = mask.clone()
    refined[background] = 0.0
    refined[foreground] = torch.clamp(refined[foreground] * 1.2, 0, 1)
    refined[(refined < 0.3) & unknown] = 0.0
    return refined


class GJJ_SDMatteMatting:
    CATEGORY = "GJJ/图像"
    FUNCTION = "matting"
    DESCRIPTION = "使用 SDMatte 模型按输入遮罩执行精细抠图，输出透明图、遮罩和遮罩预览图。"
    SEARCH_ALIASES = ["SDMatte", "RMBG", "matting", "抠图", "精细抠图", "透明物体", "mask refine"]
    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("抠图图像", "前景遮罩", "遮罩预览")
    OUTPUT_TOOLTIPS = (
        "按遮罩抠出的图像；透明背景模式会带 alpha，纯色背景模式会合成 RGB。",
        "输出前景 alpha 遮罩，白色表示保留区域。",
        "三通道遮罩预览图，便于直接接预览节点查看。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要精细抠图的图像或图像批次。"}),
                "model": (
                    list(SDMATTE_MODELS.keys()),
                    {"default": "SDMatte", "display_name": "模型", "tooltip": "选择 SDMatte 标准版或 plus 版权重。"},
                ),
                "device": (
                    ["Auto", "CPU", "GPU"],
                    {"default": "Auto", "display_name": "运行设备", "tooltip": "Auto 使用 ComfyUI 当前设备；CPU 强制走 CPU；GPU 强制走 CUDA。"},
                ),
                "process_res": (
                    "INT",
                    {"default": 1024, "min": 256, "max": 2048, "step": 8, "display_name": "处理分辨率", "tooltip": "模型推理分辨率，越高边缘越细但更慢。"},
                ),
                "transparent_object": (
                    "BOOLEAN",
                    {"default": True, "display_name": "透明物体", "tooltip": "输入主体包含透明/半透明材质时开启。"},
                ),
                "mask_refine": (
                    "BOOLEAN",
                    {"default": True, "display_name": "遮罩约束细化", "tooltip": "用输入遮罩约束模型输出，减少明显越界。"},
                ),
                "sensitivity": (
                    "FLOAT",
                    {"default": 0.9, "min": 0.1, "max": 1.0, "step": 0.1, "display_name": "约束强度", "tooltip": "越高越严格遵守输入遮罩的前景/背景区域。"},
                ),
                "mask_blur": (
                    "INT",
                    {"default": 0, "min": 0, "max": 64, "step": 1, "display_name": "遮罩模糊", "tooltip": "对输出遮罩边缘做高斯模糊，0 表示不模糊。"},
                ),
                "mask_offset": (
                    "INT",
                    {"default": 0, "min": -64, "max": 64, "step": 1, "display_name": "遮罩扩缩", "tooltip": "正数扩张遮罩，负数收缩遮罩。"},
                ),
                "invert_output": (
                    "BOOLEAN",
                    {"default": False, "display_name": "反转输出", "tooltip": "反转最终遮罩，适合需要保留背景时使用。"},
                ),
                "background": (
                    ["透明", "纯色"],
                    {"default": "透明", "display_name": "背景", "tooltip": "透明模式输出 alpha；纯色模式会合成到指定背景色。"},
                ),
                "background_color": (
                    "STRING",
                    {"default": "#222222", "display_name": "背景颜色", "tooltip": "纯色背景使用的颜色，格式为 #RRGGBB。"},
                ),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "输入遮罩", "tooltip": "白色为前景、黑色为背景；未连接时会尝试使用图像 alpha。"}),
            },
        }

    def matting(
        self,
        image: torch.Tensor,
        model: str,
        device: str,
        process_res: int,
        transparent_object: bool,
        mask_refine: bool,
        sensitivity: float,
        mask_blur: int,
        mask_offset: int,
        invert_output: bool,
        background: str,
        background_color: str,
        mask: torch.Tensor | None = None,
    ):
        try:
            sdmatte = _load_model(model, device)
            device_obj = next(sdmatte.parameters()).device
            process_res = int(process_res)

            result_images = []
            result_masks = []
            result_mask_images = []

            for index in range(image.shape[0]):
                source_pil = _tensor_to_pil(image[index])
                orig_w, orig_h = source_pil.size

                img_bchw = image[index : index + 1].permute(0, 3, 1, 2).contiguous().to(device_obj)
                img_in = _resize_norm_image_bchw(img_bchw, process_res)

                if mask is not None:
                    mask_index = min(index, mask.shape[0] - 1)
                    raw_mask = mask[mask_index : mask_index + 1]
                    mask_b1hw = raw_mask.unsqueeze(1).contiguous().to(device_obj)
                    mask_for_refine = raw_mask
                elif image.shape[-1] == 4:
                    alpha = image[index, :, :, 3]
                    mask_b1hw = alpha.unsqueeze(0).unsqueeze(0).contiguous().to(device_obj)
                    mask_for_refine = alpha.unsqueeze(0)
                else:
                    raise RuntimeError("SDMatte 需要输入遮罩；请连接 mask，或输入带 alpha 通道的图像。")

                trimap = _resize_mask_b1hw(mask_b1hw, process_res) * 2 - 1
                data = {
                    "image": img_in,
                    "is_trans": torch.tensor([1 if transparent_object else 0], device=device_obj),
                    "caption": [""],
                    "trimap": trimap,
                    "trimap_coords": torch.tensor([[0, 0, 1, 1]], dtype=trimap.dtype, device=device_obj),
                }

                with torch.inference_mode():
                    if device_obj.type == "cuda":
                        with torch.autocast(device_type="cuda", dtype=torch.float16):
                            pred_alpha = sdmatte(data)
                    else:
                        pred_alpha = sdmatte(data)

                out = transforms.Resize((orig_h, orig_w), interpolation=InterpolationMode.BILINEAR, antialias=True)(
                    pred_alpha
                )
                out = out.squeeze(1).clamp(0, 1).detach().cpu()

                if mask_refine:
                    out = _refine_mask(out, mask_for_refine, float(sensitivity))

                mask_image = Image.fromarray((out[0].numpy() * 255).astype(np.uint8), mode="L")
                mask_image = _process_mask(mask_image, invert_output, int(mask_blur), int(mask_offset))
                result_image = _apply_background(source_pil, mask_image, background, background_color)

                mask_tensor = torch.from_numpy(np.array(mask_image).astype(np.float32) / 255.0).unsqueeze(0)
                mask_preview = mask_tensor.reshape((-1, 1, mask_image.height, mask_image.width)).movedim(1, -1).expand(
                    -1, -1, -1, 3
                )

                result_images.append(_pil_to_tensor(result_image))
                result_masks.append(mask_tensor)
                result_mask_images.append(mask_preview)

            if device_obj.type == "cuda":
                torch.cuda.empty_cache()
            gc.collect()

            return (torch.cat(result_images, dim=0), torch.cat(result_masks, dim=0), torch.cat(result_mask_images, dim=0))
        except Exception as exc:
            raise RuntimeError(f"SDMatte 精细抠图失败：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SDMatteMatting}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖼️ SDMatte精细抠图"}
