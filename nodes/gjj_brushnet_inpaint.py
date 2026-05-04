from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path

import torch
import torch.nn.functional as F
import torchvision.transforms as T

import folder_paths


NODE_NAME = "GJJ_BrushNetInpaint"

MODE_BRUSHNET = "BrushNet局部重绘"
MODE_PP_TEXT = "PowerPaint文本引导"
MODE_PP_SHAPE = "PowerPaint形状引导"
MODE_PP_REMOVE = "PowerPaint物体移除"
MODE_PP_CONTEXT = "PowerPaint上下文补图"
MODE_PP_OUTPAINT = "PowerPaint图像外扩"
MODE_RAUNET = "RAUNet高分辨率"
MODE_CUT = "裁切补图区域"
MODE_BLEND = "融合补图结果"

MODES = [
    MODE_BRUSHNET,
    MODE_PP_TEXT,
    MODE_PP_SHAPE,
    MODE_PP_REMOVE,
    MODE_PP_CONTEXT,
    MODE_PP_OUTPAINT,
    MODE_RAUNET,
    MODE_CUT,
    MODE_BLEND,
]

POWERPAINT_FUNCTIONS = {
    MODE_PP_TEXT: "text guided",
    MODE_PP_SHAPE: "shape guided",
    MODE_PP_REMOVE: "object removal",
    MODE_PP_CONTEXT: "context aware",
    MODE_PP_OUTPAINT: "image outpainting",
}

_BRMODEL_CACHE: dict[tuple[str, str], dict] = {}
_PP_CLIP_CACHE: dict[tuple[str, str], object] = {}
_RUNTIME_MODULE = None
_RAUNET_MODULE = None


def _candidate_model_roots() -> list[Path]:
    roots: list[Path] = []
    try:
        roots.append(Path(__file__).resolve().parents[3] / "models")
    except Exception:
        pass
    try:
        roots.append(Path(folder_paths.models_dir))
    except Exception:
        pass
    roots.append(folder_paths.models_dir)
    seen: set[str] = set()
    unique: list[Path] = []
    for root in roots:
        if root.exists():
            key = str(root).lower()
            if key not in seen:
                seen.add(key)
                unique.append(root)
    return unique


def _scan_files(exts: tuple[str, ...]) -> list[Path]:
    files: list[Path] = []
    for root in _candidate_model_roots():
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in exts:
                files.append(path)
    return files


def _score_path(path: Path, include: tuple[str, ...], exclude: tuple[str, ...] = ()) -> int:
    text = str(path).replace("\\", "/").lower()
    name = path.name.lower()
    if any(token in text for token in exclude):
        return -10000
    score = 0
    for index, token in enumerate(include):
        token = token.lower()
        if token in name:
            score += 80 - index
        elif token in text:
            score += 30 - index
        else:
            return -10000
    if "/inpaint/" in text:
        score += 20
    if "/brushnet/" in text or "/powerpaint/" in text:
        score += 30
    return score


def _find_best_model(label: str, include_sets: tuple[tuple[str, ...], ...], exts: tuple[str, ...], exclude: tuple[str, ...] = ()) -> Path:
    candidates: list[tuple[int, Path]] = []
    for path in _scan_files(exts):
        best = max(_score_path(path, include, exclude) for include in include_sets)
        if best > -10000:
            candidates.append((best, path))
    if candidates:
        candidates.sort(key=lambda item: (-item[0], len(str(item[1])), str(item[1]).lower()))
        return candidates[0][1]
    roots = "\n".join(str(root) for root in _candidate_model_roots())
    raise RuntimeError(f"未找到 {label} 模型。\n已在以下 models 目录模糊搜索：\n{roots}")


def _resolve_brushnet_path(mode: str) -> Path:
    if mode in POWERPAINT_FUNCTIONS:
        return _find_best_model("PowerPaint", (("powerpaint",),), (".safetensors", ".pt", ".pth"), exclude=("controlnet",))
    return _find_best_model(
        "BrushNet",
        (("brushnet",), ("random_mask",), ("segmentation_mask",)),
        (".safetensors", ".pt", ".pth"),
        exclude=("controlnet", "powerpaint"),
    )


def _resolve_base_clip_path() -> Path:
    return _find_best_model("PowerPaint基础CLIP", (("model.fp16",), ("clip", "large", "patch14")), (".safetensors", ".pt", ".pth"))


def _resolve_powerpaint_clip_path() -> Path:
    return _find_best_model("PowerPaint CLIP权重", (("powerpaint", "pytorch_model"), ("powerpaint", ".bin")), (".bin", ".safetensors", ".pt", ".pth"))


def _runtime():
    global _RUNTIME_MODULE
    if _RUNTIME_MODULE is not None:
        return _RUNTIME_MODULE
    try:
        _RUNTIME_MODULE = _load_vendor_module("gjj_brushnet_runtime.brushnet_nodes", "brushnet_nodes.py")
        return _RUNTIME_MODULE
    except ModuleNotFoundError as exc:
        if exc.name == "diffusers":
            raise RuntimeError("BrushNet 运行时需要 diffusers。当前 Python 环境未安装 diffusers，无法执行 BrushNet/PowerPaint。") from exc
        raise


def _raunet_runtime():
    global _RAUNET_MODULE
    if _RAUNET_MODULE is not None:
        return _RAUNET_MODULE
    _RAUNET_MODULE = _load_vendor_module("gjj_brushnet_runtime.raunet_nodes", "raunet_nodes.py")
    return _RAUNET_MODULE


def _load_vendor_module(module_name: str, filename: str):
    runtime_root = Path(__file__).resolve().parents[1] / "vendor" / "brushnet_runtime"
    package_name = "gjj_brushnet_runtime"
    package = sys.modules.get(package_name)
    if package is None:
        package = types.ModuleType(package_name)
        package.__path__ = [str(runtime_root)]  # type: ignore[attr-defined]
        sys.modules[package_name] = package
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, str(runtime_root / filename))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 BrushNet 运行时：{runtime_root / filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_brmodel(mode: str, dtype_name: str) -> dict:
    runtime = _runtime()
    weight_path = _resolve_brushnet_path(mode)
    cache_key = (str(weight_path), dtype_name)
    cached = _BRMODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    from accelerate import init_empty_weights, load_checkpoint_and_dispatch
    import comfy

    state_dict = comfy.utils.load_torch_file(str(weight_path))
    down_count, mid_count, up_count, key_count = runtime.brushnet_blocks(state_dict)
    del state_dict

    is_sdxl = False
    is_powerpaint = False
    if down_count == 24 and mid_count == 2 and up_count == 30:
        is_powerpaint = key_count != 322
    elif down_count == 18 and mid_count == 2 and up_count == 22:
        is_sdxl = True
    else:
        raise RuntimeError(f"无法识别 BrushNet/PowerPaint 模型结构：{weight_path}")

    with init_empty_weights():
        if is_sdxl:
            config = runtime.BrushNetModel.load_config(runtime.brushnet_xl_config_file)
            brmodel = runtime.BrushNetModel.from_config(config)
        elif is_powerpaint:
            config = runtime.PowerPaintModel.load_config(runtime.powerpaint_config_file)
            brmodel = runtime.PowerPaintModel.from_config(config)
        else:
            config = runtime.BrushNetModel.load_config(runtime.brushnet_config_file)
            brmodel = runtime.BrushNetModel.from_config(config)

    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
        "float64": torch.float64,
    }
    torch_dtype = dtype_map.get(dtype_name, torch.float16)
    brmodel = load_checkpoint_and_dispatch(
        brmodel,
        str(weight_path),
        device_map="sequential",
        max_memory=None,
        offload_folder=None,
        offload_state_dict=False,
        dtype=torch_dtype,
        force_hooks=False,
    )
    bundle = {"brushnet": brmodel, "SDXL": is_sdxl, "PP": is_powerpaint, "dtype": torch_dtype, "path": str(weight_path)}
    _BRMODEL_CACHE[cache_key] = bundle
    return bundle


def _load_powerpaint_clip():
    runtime = _runtime()
    base_path = _resolve_base_clip_path()
    pp_path = _resolve_powerpaint_clip_path()
    cache_key = (str(base_path), str(pp_path))
    cached = _PP_CLIP_CACHE.get(cache_key)
    if cached is not None:
        return cached

    import comfy

    pp_clip = comfy.sd.load_clip(ckpt_paths=[str(base_path)])
    pp_tokenizer = runtime.TokenizerWrapper(pp_clip.tokenizer.clip_l.tokenizer)
    pp_text_encoder = pp_clip.patcher.model.clip_l.transformer
    runtime.add_tokens(
        tokenizer=pp_tokenizer,
        text_encoder=pp_text_encoder,
        placeholder_tokens=["P_ctxt", "P_shape", "P_obj"],
        initialize_tokens=["a", "a", "a"],
        num_vectors_per_token=10,
    )
    pp_text_encoder.load_state_dict(comfy.utils.load_torch_file(str(pp_path)), strict=False)
    pp_clip.tokenizer.clip_l.tokenizer = pp_tokenizer
    pp_clip.patcher.model.clip_l.transformer = pp_text_encoder
    _PP_CLIP_CACHE[cache_key] = pp_clip
    return pp_clip


def _require(value, name: str):
    if value is None:
        raise RuntimeError(f"当前模式需要连接：{name}")
    return value


def _dummy_image() -> torch.Tensor:
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _dummy_mask() -> torch.Tensor:
    return torch.zeros((1, 64, 64), dtype=torch.float32)


def _dummy_latent(image=None) -> dict:
    if torch.is_tensor(image) and image.ndim >= 4:
        batch = int(image.shape[0])
        height = max(8, int(image.shape[1]) // 8)
        width = max(8, int(image.shape[2]) // 8)
    else:
        batch, height, width = 1, 8, 8
    return {"samples": torch.zeros((batch, 4, height, width), dtype=torch.float32)}


def _origin_batch(batch: int = 1) -> torch.Tensor:
    return torch.zeros((batch, 2), dtype=torch.int32)


def _check_image_mask(image: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    if len(image.shape) < 4:
        image = image[None, :, :, :]
    if len(mask.shape) > 3:
        mask = mask[:, :, :, 0]
    elif len(mask.shape) < 3:
        mask = mask[None, :, :]
    if image.shape[0] > mask.shape[0]:
        if mask.shape[0] == 1:
            mask = torch.cat([mask] * image.shape[0], dim=0)
        else:
            empty = torch.zeros((image.shape[0] - mask.shape[0], mask.shape[1], mask.shape[2]), dtype=mask.dtype, device=mask.device)
            mask = torch.cat([mask, empty], dim=0)
    elif image.shape[0] < mask.shape[0]:
        mask = mask[: image.shape[0], :, :]
    return image, mask


def _cut_with_mask(mask: torch.Tensor, width: int, height: int) -> tuple[int, int, int, int]:
    iy, ix = (mask == 1).nonzero(as_tuple=True)
    h0, w0 = mask.shape
    if iy.numel() == 0:
        x_c = w0 / 2.0
        y_c = h0 / 2.0
    else:
        x_min = ix.min().item()
        x_max = ix.max().item()
        y_min = iy.min().item()
        y_max = iy.max().item()
        if x_max - x_min > width or y_max - y_min > height:
            raise RuntimeError("遮罩区域大于裁切尺寸，请增大裁切宽度或高度。")
        x_c = (x_min + x_max) / 2.0
        y_c = (y_min + y_max) / 2.0

    width2 = width / 2.0
    height2 = height / 2.0
    if w0 <= width:
        x0, w = 0, w0
    else:
        x0, w = max(0, x_c - width2), width
        if x0 + width > w0:
            x0 = w0 - width
    if h0 <= height:
        y0, h = 0, h0
    else:
        y0, h = max(0, y_c - height2), height
        if y0 + height > h0:
            y0 = h0 - height
    return int(x0), int(y0), int(w), int(h)


def _cut_for_inpaint(image: torch.Tensor, mask: torch.Tensor, width: int, height: int):
    image, mask = _check_image_mask(image, mask)
    images, masks, origins = [], [], []
    for i in range(image.shape[0]):
        x0, y0, w, h = _cut_with_mask(mask[i], width, height)
        images.append(image[i][y0 : y0 + h, x0 : x0 + w, :])
        masks.append(mask[i][y0 : y0 + h, x0 : x0 + w])
        origins.append(torch.IntTensor([x0, y0]))
    return torch.stack(images), torch.stack(masks), torch.stack(origins)


def _blend_inpaint(inpaint: torch.Tensor, original: torch.Tensor, mask: torch.Tensor, kernel: int, sigma: float, origin=None):
    original, mask = _check_image_mask(original, mask)
    if len(inpaint.shape) < 4:
        inpaint = inpaint[None, :, :, :]
    if inpaint.shape[0] < original.shape[0]:
        original = original[: inpaint.shape[0], :, :]
        mask = mask[: inpaint.shape[0], :, :]
    if inpaint.shape[0] > original.shape[0]:
        original = torch.cat([original] * int((inpaint.shape[0] + original.shape[0] - 1) / original.shape[0]), dim=0)[: inpaint.shape[0]]
        mask = torch.cat([mask] * int((inpaint.shape[0] + mask.shape[0] - 1) / mask.shape[0]), dim=0)[: inpaint.shape[0]]
    if kernel % 2 == 0:
        kernel += 1
    transform = T.GaussianBlur(kernel_size=(kernel, kernel), sigma=(sigma, sigma))
    results, blurred_masks = [], []
    for i in range(inpaint.shape[0]):
        if origin is None:
            blurred = transform(mask[i][None, None, :, :]).to(original.device).to(original.dtype)
            resized = F.interpolate(inpaint[i][None, :, :, :].permute(0, 3, 1, 2), size=(original[i].shape[0], original[i].shape[1])).permute(0, 2, 3, 1).to(original.device).to(original.dtype)
            result = original[i] * (1.0 - blurred[0][0][:, :, None]) + resized[0] * blurred[0][0][:, :, None]
            blurred_masks.append(blurred[0][0])
        else:
            height, width, _ = original[i].shape
            x0 = int(origin[i][0].item())
            y0 = int(origin[i][1].item())
            padded_mask = F.pad(mask[i], pad=(x0, width - x0 - mask[i].shape[1], y0, height - y0 - mask[i].shape[0]), mode="constant", value=0)
            blurred = transform(padded_mask[None, None, :, :]).to(original.device).to(original.dtype)
            padded_image = F.pad(inpaint[i], pad=(0, 0, x0, width - x0 - inpaint[i].shape[1], y0, height - y0 - inpaint[i].shape[0]), mode="constant", value=0)
            result = original[i] * (1.0 - blurred[0][0][:, :, None]) + padded_image.to(original.device).to(original.dtype) * blurred[0][0][:, :, None]
            blurred_masks.append(blurred[0][0])
        results.append(result)
    return torch.stack(results), torch.stack(blurred_masks)


class GJJ_BrushNetInpaint:
    CATEGORY = "GJJ"
    FUNCTION = "run"
    DESCRIPTION = "综合迁移 BrushNet、PowerPaint、RAUNet、裁切与融合补图功能；模型会在 models 下模糊搜索。"
    SEARCH_ALIASES = ["brushnet", "powerpaint", "raunet", "inpaint", "补图", "局部重绘", "物体移除", "外扩"]
    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT", "IMAGE", "MASK", "VECTOR")
    RETURN_NAMES = ("模型", "正向条件", "反向条件", "潜空间", "图像", "遮罩", "裁切原点")
    OUTPUT_TOOLTIPS = (
        "BrushNet/PowerPaint/RAUNet 模式输出已 patch 的模型。",
        "传递到 KSampler 的正向条件。",
        "传递到 KSampler 的反向条件。",
        "传递到 KSampler 的初始潜空间。",
        "裁切/融合模式输出图像；采样模式透传输入图像。",
        "裁切/融合模式输出遮罩；采样模式透传输入遮罩。",
        "裁切模式输出原点，用于融合模式把局部结果放回原图。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (MODES, {"default": MODE_BRUSHNET, "display_name": "功能模式", "tooltip": "选择 BrushNet、PowerPaint、RAUNet、裁切或融合功能。"}),
                "dtype": (["float16", "bfloat16", "float32", "float64"], {"default": "float16", "display_name": "模型精度", "tooltip": "BrushNet/PowerPaint 权重加载精度。"}),
                "scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05, "display_name": "控制强度", "tooltip": "BrushNet/PowerPaint 对采样的影响强度。"}),
                "start_at": ("INT", {"default": 0, "min": 0, "max": 10000, "step": 1, "display_name": "开始步", "tooltip": "从第几步开始启用 BrushNet/PowerPaint。"}),
                "end_at": ("INT", {"default": 10000, "min": 0, "max": 10000, "step": 1, "display_name": "结束步", "tooltip": "到第几步结束 BrushNet/PowerPaint。"}),
                "powerpaint_fitting": ("FLOAT", {"default": 1.0, "min": 0.3, "max": 1.0, "step": 0.05, "display_name": "PowerPaint贴合", "tooltip": "PowerPaint 内部提示嵌入混合比例。"}),
                "save_memory": (["none", "auto", "max"], {"default": "none", "display_name": "省显存", "tooltip": "PowerPaint 的 attention slice 设置。"}),
                "cut_width": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64, "display_name": "裁切宽度", "tooltip": "裁切补图区域模式使用。"}),
                "cut_height": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64, "display_name": "裁切高度", "tooltip": "裁切补图区域模式使用。"}),
                "blend_kernel": ("INT", {"default": 11, "min": 1, "max": 1001, "step": 2, "display_name": "融合核大小", "tooltip": "融合补图结果模式的高斯模糊核。偶数会自动加一。"}),
                "blend_sigma": ("FLOAT", {"default": 10.0, "min": 0.01, "max": 1000.0, "step": 0.1, "display_name": "融合柔边", "tooltip": "融合补图结果模式的高斯模糊 sigma。"}),
                "raunet_du_start": ("INT", {"default": 0, "min": 0, "max": 10000, "display_name": "RAUNet下采样开始", "tooltip": "RAUNet 修改下采样的开始步。"}),
                "raunet_du_end": ("INT", {"default": 4, "min": 0, "max": 10000, "display_name": "RAUNet下采样结束", "tooltip": "RAUNet 修改下采样的结束步。"}),
                "raunet_xa_start": ("INT", {"default": 4, "min": 0, "max": 10000, "display_name": "RAUNet注意力开始", "tooltip": "RAUNet 修改注意力路径的开始步。"}),
                "raunet_xa_end": ("INT", {"default": 10, "min": 0, "max": 10000, "display_name": "RAUNet注意力结束", "tooltip": "RAUNet 修改注意力路径的结束步。"}),
            },
            "optional": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "BrushNet/PowerPaint/RAUNet 模式需要连接；裁切和融合模式可不连。"}),
                "vae": ("VAE", {"display_name": "VAE", "tooltip": "BrushNet/PowerPaint 模式需要连接。"}),
                "image": ("IMAGE", {"display_name": "原图", "tooltip": "需要补图、裁切或融合的原图。"}),
                "mask": ("MASK", {"display_name": "遮罩", "tooltip": "需要重绘或融合的区域遮罩。"}),
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "传递给 BrushNet/PowerPaint 和 KSampler 的正向条件。"}),
                "negative": ("CONDITIONING", {"display_name": "反向条件", "tooltip": "传递给 BrushNet/PowerPaint 和 KSampler 的反向条件。"}),
                "inpaint_image": ("IMAGE", {"display_name": "补图结果", "tooltip": "融合补图结果模式中需要放回原图的局部或完整补图结果。"}),
                "origin": ("VECTOR", {"display_name": "裁切原点", "tooltip": "裁切补图区域模式输出的原点，可连接到融合补图结果模式。"}),
            },
        }

    def run(
        self,
        mode,
        dtype,
        scale,
        start_at,
        end_at,
        powerpaint_fitting,
        save_memory,
        cut_width,
        cut_height,
        blend_kernel,
        blend_sigma,
        raunet_du_start,
        raunet_du_end,
        raunet_xa_start,
        raunet_xa_end,
        vae=None,
        image=None,
        mask=None,
        positive=None,
        negative=None,
        inpaint_image=None,
        origin=None,
        model=None,
    ):
        out_image = image if image is not None else _dummy_image()
        out_mask = mask if mask is not None else _dummy_mask()
        out_origin = _origin_batch(out_image.shape[0] if torch.is_tensor(out_image) else 1)
        out_latent = _dummy_latent(out_image)
        out_positive = positive if positive is not None else []
        out_negative = negative if negative is not None else []

        if mode == MODE_RAUNET:
            model = _require(model, "模型")
            patched_model = _raunet_runtime().RAUNet().model_update(model, raunet_du_start, raunet_du_end, raunet_xa_start, raunet_xa_end)[0]
            return (patched_model, out_positive, out_negative, out_latent, out_image, out_mask, out_origin)

        if mode == MODE_CUT:
            image = _require(image, "原图")
            mask = _require(mask, "遮罩")
            cut_image, cut_mask, cut_origin = _cut_for_inpaint(image, mask, cut_width, cut_height)
            return (model, out_positive, out_negative, _dummy_latent(cut_image), cut_image, cut_mask, cut_origin)

        if mode == MODE_BLEND:
            original = _require(image, "原图")
            mask = _require(mask, "遮罩")
            inpaint = _require(inpaint_image, "补图结果")
            blend_image, blend_mask = _blend_inpaint(inpaint, original, mask, blend_kernel, blend_sigma, origin)
            return (model, out_positive, out_negative, _dummy_latent(blend_image), blend_image, blend_mask, origin if origin is not None else _origin_batch(blend_image.shape[0]))

        runtime = _runtime()
        model = _require(model, "模型")
        vae = _require(vae, "VAE")
        image = _require(image, "原图")
        mask = _require(mask, "遮罩")
        positive = _require(positive, "正向条件")
        negative = _require(negative, "反向条件")
        brmodel = _load_brmodel(mode, dtype)

        if mode in POWERPAINT_FUNCTIONS:
            pp_clip = _load_powerpaint_clip()
            patched_model, pos, neg, latent = runtime.PowerPaint().model_update(
                model,
                vae,
                image,
                mask,
                brmodel,
                pp_clip,
                positive,
                negative,
                powerpaint_fitting,
                POWERPAINT_FUNCTIONS[mode],
                scale,
                start_at,
                end_at,
                save_memory,
            )
        else:
            patched_model, pos, neg, latent = runtime.BrushNet().model_update(
                model,
                vae,
                image,
                mask,
                brmodel,
                positive,
                negative,
                scale,
                start_at,
                end_at,
            )

        return (patched_model, pos, neg, latent, image, mask, _origin_batch(image.shape[0]))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BrushNetInpaint}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖌️ BrushNet补图"}
