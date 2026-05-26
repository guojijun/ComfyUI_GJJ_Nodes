from __future__ import annotations

import gc
import importlib.util
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )


NODE_LOADER = "GJJ_LongCatVideoLoader"
NODE_GENERATOR = "GJJ_LongCatVideoGenerator"
DISPLAY_LOADER = "GJJ · 🐱 LongCat视频加载器"
DISPLAY_GENERATOR = "GJJ · 🎬 LongCat图文生视频"
GJJ_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = GJJ_ROOT / "vendor" / "longcat_video_runtime"
AUTO = "自动检测"
MODEL_HINTS = {
    "dit": ("Diffusion_models", "LongCat-Avatar"),
    "text_encoder": ("text_encoders", "umt5-xxl-enc"),
    "audio_encoder": ("audio_encoders", "whisper_large_v3_encoder"),
    "lora": ("loras", "LongCat-Avatar-15"),
    "vae": ("vae", "Wan2_1_VAE_"),
}
CATEGORY_ALIASES = {
    "diffusion_models": ("diffusion_models", "Diffusion_models"),
    "text_encoders": ("text_encoders", "textencoder", "text_encoder"),
    "audio_encoders": ("audio_encoders", "audio_encoder"),
    "loras": ("loras", "lora"),
    "vae": ("vae",),
}
NEGATIVE_PROMPT = (
    "Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, static, "
    "overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, "
    "poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, "
    "messy background, three legs, many people in the background, walking backwards"
)

_PIPE_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_DEPENDENCY_SPECS = [
    {"module_name": "torch", "package_name": "torch", "display_name": "PyTorch", "description": "LongCat 推理需要 PyTorch/CUDA。"},
    {"module_name": "diffusers", "package_name": "diffusers", "display_name": "diffusers", "description": "加载 LongCat VAE、调度器和后处理。"},
    {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "加载 UMT5 文本编码器。"},
    {"module_name": "einops", "package_name": "einops", "display_name": "einops", "description": "LongCat 张量维度重排。"},
    {"module_name": "ftfy", "package_name": "ftfy", "display_name": "ftfy", "description": "提示词清洗。"},
    {"module_name": "regex", "package_name": "regex", "display_name": "regex", "description": "提示词清洗。"},
    {"module_name": "safetensors", "package_name": "safetensors", "display_name": "safetensors", "description": "读取 DiT/LoRA 权重。"},
]


def _norm_rel(path: str | Path) -> str:
    return str(path).replace("\\", "/").strip("/")


def _models_roots() -> list[Path]:
    roots: list[Path] = []
    if folder_paths is not None:
        models_dir = getattr(folder_paths, "models_dir", None)
        if models_dir:
            roots.append(Path(models_dir))
    roots.extend([Path("D:/AI/MOD/models"), Path("D:/AI/CUI/ComfyUI/models")])
    out: list[Path] = []
    seen = set()
    for root in roots:
        try:
            key = str(root.resolve()).lower()
        except Exception:
            key = str(root).lower()
        if key not in seen:
            seen.add(key)
            out.append(root)
    return out


def _category_roots(category: str) -> list[Path]:
    roots: list[Path] = []
    if folder_paths is not None:
        try:
            for item in folder_paths.get_folder_paths(category):
                roots.append(Path(item))
        except Exception:
            pass
    aliases = CATEGORY_ALIASES.get(category, (category,))
    for model_root in _models_roots():
        roots.extend(model_root / alias for alias in aliases)
    out: list[Path] = []
    seen = set()
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            out.append(root)
    return out


def _display_category_path(category: str, path: Path) -> str:
    for root in _category_roots(category):
        try:
            return _norm_rel(Path("models") / root.name / path.relative_to(root))
        except Exception:
            continue
    return _norm_rel(path)


def _full_repo_roots() -> list[Path]:
    roots = [Path("D:/AI/LongCat-Video")]
    for model_root in _models_roots():
        roots.extend(
            [
                model_root / "LongCat-Video",
                model_root / "diffusion_models" / "LongCat-Video",
            ]
        )
    out: list[Path] = []
    seen = set()
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            out.append(root)
    return out


def _is_complete_repo(root: Path) -> bool:
    return (
        (root / "tokenizer" / "tokenizer.json").exists()
        and (root / "text_encoder" / "config.json").exists()
        and _dir_has_safetensors(root / "text_encoder")
        and (root / "vae" / "config.json").exists()
        and _dir_has_safetensors(root / "vae")
        and (root / "scheduler" / "scheduler_config.json").exists()
        and (root / "dit" / "config.json").exists()
        and _dir_has_safetensors(root / "dit")
    )


def _dir_has_safetensors(path: Path) -> bool:
    return path.exists() and any(p.is_file() and p.suffix == ".safetensors" for p in path.rglob("*.safetensors"))


def _repo_choices() -> list[str]:
    found: list[str] = []
    for root in _full_repo_roots():
        if _is_complete_repo(root):
            found.append(str(root))
    return [AUTO] + found if found else [AUTO]


def _default_choice(choices: list[str]) -> str:
    for choice in choices:
        if choice and choice != AUTO:
            return choice
    return AUTO


def _existing_category_dir(category: str, rel_dir: str, required_file: str) -> Path | None:
    for root in _category_roots(category):
        candidate = root / rel_dir
        if (candidate / required_file).exists():
            return candidate
    return None


def _find_category_dir(category: str, required_file: str, keywords: tuple[str, ...]) -> Path | None:
    for root in _category_roots(category):
        if not root.exists():
            continue
        for marker in root.rglob(required_file):
            if not marker.is_file():
                continue
            rel_text = _norm_rel(marker.parent).lower()
            if all(k.lower() in rel_text for k in keywords):
                return marker.parent
    return None


def _resolve_category_components() -> dict[str, Path] | None:
    tokenizer = _existing_category_dir("tokenizers", "LongCat-Video/tokenizer", "tokenizer.json") or _find_category_dir("tokenizers", "tokenizer.json", ("longcat",))
    text_encoder = _find_category_dir("text_encoders", "config.json", (MODEL_HINTS["text_encoder"][1],)) or _existing_category_dir("text_encoders", "LongCat-Video/text_encoder", "config.json") or _find_category_dir("text_encoders", "config.json", ("longcat", "text_encoder"))
    vae = _find_category_dir("vae", "config.json", (MODEL_HINTS["vae"][1],)) or _existing_category_dir("vae", "LongCat-Video/vae", "config.json") or _find_category_dir("vae", "config.json", ("longcat", "vae"))
    scheduler = _existing_category_dir("configs", "LongCat-Video/scheduler", "scheduler_config.json") or _find_category_dir("configs", "scheduler_config.json", ("longcat", "scheduler"))
    dit = _find_category_dir("diffusion_models", "config.json", (MODEL_HINTS["dit"][1],)) or _existing_category_dir("diffusion_models", "LongCat-Video/dit", "config.json") or _find_category_dir("diffusion_models", "config.json", ("longcat", "dit"))
    if not all([tokenizer, text_encoder, vae, scheduler, dit]):
        return None
    if not (_dir_has_safetensors(text_encoder) and _dir_has_safetensors(vae) and _dir_has_safetensors(dit)):
        return None
    return {
        "tokenizer": tokenizer,
        "text_encoder": text_encoder,
        "vae": vae,
        "scheduler": scheduler,
        "dit": dit,
        "cfg_lora": _resolve_lora_file("cfg_step_lora.safetensors"),
        "refine_lora": _resolve_lora_file("refinement_lora.safetensors"),
    }


def _resolve_lora_file(filename: str) -> Path | None:
    for root in _category_roots("loras"):
        if root.exists() and filename == "cfg_step_lora.safetensors":
            matches = [p for p in root.rglob("*.safetensors") if MODEL_HINTS["lora"][1].lower() in _norm_rel(p).lower()]
            if matches:
                return matches[0]
        for rel in (Path("LongCat-Video") / filename, Path(filename)):
            candidate = root / rel
            if candidate.exists():
                return candidate
        if root.exists():
            matches = [p for p in root.rglob(filename) if "longcat" in _norm_rel(p).lower()]
            if matches:
                return matches[0]
    for repo in _full_repo_roots():
        candidate = repo / "lora" / filename
        if candidate.exists():
            return candidate
    return None


def _resolve_components(selected_repo: str) -> dict[str, Path]:
    selected = Path(str(selected_repo).strip().strip('"')) if selected_repo and selected_repo != AUTO else None
    if selected and _is_complete_repo(selected):
        return {
            "tokenizer": selected / "tokenizer",
            "text_encoder": selected / "text_encoder",
            "vae": selected / "vae",
            "scheduler": selected / "scheduler",
            "dit": selected / "dit",
            "cfg_lora": selected / "lora" / "cfg_step_lora.safetensors",
            "refine_lora": selected / "lora" / "refinement_lora.safetensors",
        }
    category_components = _resolve_category_components()
    if category_components is not None:
        return category_components
    for repo in _full_repo_roots():
        if _is_complete_repo(repo):
            return {
                "tokenizer": repo / "tokenizer",
                "text_encoder": repo / "text_encoder",
                "vae": repo / "vae",
                "scheduler": repo / "scheduler",
                "dit": repo / "dit",
                "cfg_lora": repo / "lora" / "cfg_step_lora.safetensors",
                "refine_lora": repo / "lora" / "refinement_lora.safetensors",
            }
    raise FileNotFoundError("missing LongCat-Video model")


def _missing_dependency_specs() -> list[dict[str, str]]:
    return [spec for spec in _DEPENDENCY_SPECS if importlib.util.find_spec(spec["module_name"]) is None]


def _startup_missing_models() -> list[dict[str, str]]:
    try:
        _resolve_components(AUTO)
        return []
    except Exception:
        required = [
            ("LongCat Tokenizer", "models/tokenizers/LongCat-Video/tokenizer", "tokenizer.json", "LongCat-Video 官方 tokenizer。"),
            ("LongCat Text Encoder", f"models/{MODEL_HINTS['text_encoder'][0]}/{MODEL_HINTS['text_encoder'][1]}", "config.json", "LongCat-Video 官方 UMT5 文本编码器。"),
            ("LongCat VAE", f"models/{MODEL_HINTS['vae'][0]}/{MODEL_HINTS['vae'][1]}", "config.json", "LongCat-Video 官方视频 VAE。"),
            ("LongCat Scheduler", "models/configs/LongCat-Video/scheduler", "scheduler_config.json", "LongCat-Video 官方调度器。"),
            ("LongCat DiT", f"models/{MODEL_HINTS['dit'][0]}/{MODEL_HINTS['dit'][1]}", "config.json", "LongCat-Video 官方 DiT。"),
            ("CFG Step LoRA", f"models/{MODEL_HINTS['lora'][0]}/{MODEL_HINTS['lora'][1]}", "*.safetensors", "蒸馏模式推荐 LoRA。"),
        ]
        return [make_missing_model_spec(label=a, subdir=b, filename=c, description=d) for a, b, c, d in required]


_STARTUP_REPORT = build_dependency_model_report(
    node_name=DISPLAY_LOADER,
    missing_dependencies=_missing_dependency_specs(),
    missing_models=_startup_missing_models(),
    install_packages=[spec["package_name"] for spec in _missing_dependency_specs()],
    description="LongCat-Video 图文生视频需要官方 LongCat-Video 基础模型。已兼容完整 HuggingFace 目录和拆分后的 models 分类目录。",
    model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video",
)


def _ensure_runtime(unique_id=None):
    missing = _missing_dependency_specs()
    if missing:
        raise_dependency_model_error(
            node_name=DISPLAY_LOADER,
            missing_dependencies=missing,
            install_packages=[spec["package_name"] for spec in missing],
            description="LongCat-Video 推理运行依赖不完整。",
            unique_id=unique_id,
        )
    if str(VENDOR_ROOT) not in sys.path:
        sys.path.insert(0, str(VENDOR_ROOT))


def _device():
    load_dependency_at_runtime("torch", DISPLAY_LOADER, package_name="torch")
    import torch

    if model_management is not None:
        try:
            return model_management.get_torch_device()
        except Exception:
            pass
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _clear_cache():
    gc.collect()
    if model_management is not None:
        try:
            model_management.soft_empty_cache()
        except Exception:
            pass
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _pil_from_image(image):
    from PIL import Image

    if image is None:
        return None
    frame = image[0].detach().cpu().numpy()
    frame = np.clip(frame * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(frame, "RGB")


def _frames_to_tensor(frames: Any):
    load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch")
    import torch

    if isinstance(frames, torch.Tensor):
        tensor = frames.detach().float().cpu()
        if tensor.ndim == 5:
            tensor = tensor[0]
        if tensor.ndim == 4 and tensor.shape[1] in (1, 3, 4):
            tensor = tensor.permute(0, 2, 3, 1)
        if tensor.max() > 1.5:
            tensor = tensor / 255.0
        return tensor.clamp(0, 1)
    if isinstance(frames, np.ndarray):
        arr = frames[0] if frames.ndim == 5 else frames
        if arr.max() > 1.5:
            arr = arr / 255.0
        return torch.from_numpy(np.clip(arr, 0, 1).astype(np.float32))
    arr = np.stack([np.asarray(img).astype(np.float32) / 255.0 for img in frames], axis=0)
    return torch.from_numpy(np.clip(arr, 0, 1).astype(np.float32))


def _path_label(path: Path, category: str | None = None) -> str:
    if category:
        return _display_category_path(category, path)
    return _norm_rel(path)


class GJJ_LongCatVideoLoader:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "load"
    RETURN_TYPES = ("GJJ_LONGCAT_VIDEO_PIPELINE", "STRING")
    RETURN_NAMES = ("LongCat管线", "加载状态")
    OUTPUT_TOOLTIPS = ("已加载的 LongCat-Video 图文生视频管线。", "加载路径、精度和依赖状态。")
    DESCRIPTION = _STARTUP_REPORT["warning_message"] if not _STARTUP_REPORT.get("available") else "加载 LongCat-Video 官方图文生视频推理管线。LongCat Avatar 1.5 数字人推荐使用 WanVideo 成功工作流模型。"
    GJJ_HELP = {
        "description": _STARTUP_REPORT["panel_message"] if not _STARTUP_REPORT.get("available") else "加载 LongCat-Video：旧版官方 LongCat-Video pipeline 加载器。LongCat Avatar 1.5 数字人请优先使用已验证的 WanVideo 工作流模型。",
        "models": [
            "数字人成功工作流模型：models/Diffusion_models/LongCat-Avatar-15_bf16.safetensors",
            "数字人成功工作流LoRA：models/loras/LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors",
            "数字人成功工作流Whisper：models/audio_encoders/whisper_large_v3_encoder_fp16.safetensors",
            "数字人成功工作流T5：models/text_encoders/umt5-xxl-enc-bf16.safetensors",
            "数字人成功工作流VAE：models/vae/Wan2_1_VAE_bf16.safetensors",
            "models/tokenizers/LongCat-Video/tokenizer",
            "models/text_encoders/*umt5-xxl-enc*",
            "models/vae/*Wan2_1_VAE_*",
            "models/configs/LongCat-Video/scheduler",
            "models/Diffusion_models/*LongCat-Avatar*",
            "models/loras/*LongCat-Avatar-15*",
            "models/loras/LongCat-Video/refinement_lora.safetensors",
        ],
        "copy_text": _STARTUP_REPORT.get("copy_text", ""),
        "copy_label": _STARTUP_REPORT.get("copy_label", ""),
    }

    @classmethod
    def INPUT_TYPES(cls):
        repo_choices = _repo_choices()
        return {
            "required": {
                "模型目录": (repo_choices, {"default": _default_choice(repo_choices), "display_name": "模型目录", "tooltip": "可选择完整 LongCat-Video 目录；自动检测会优先使用拆分后的 models 分类目录，其次使用 D:/AI/LongCat-Video。"}),
                "精度": (["自动", "BF16", "FP32"], {"default": "自动", "display_name": "精度", "tooltip": "CUDA 默认 BF16，CPU 默认 FP32。"}),
            },
            "optional": {
                "保持缓存": ("BOOLEAN", {"default": True, "display_name": "保持缓存", "tooltip": "开启后重复执行会复用已加载管线，减少重复加载时间。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def load(self, 模型目录=AUTO, 精度="自动", 保持缓存=True, unique_id=None):
        _ensure_runtime(unique_id=unique_id)
        missing_models = _startup_missing_models()
        if missing_models:
            raise_dependency_model_error(
                node_name=DISPLAY_LOADER,
                missing_models=missing_models,
                description="LongCat-Video 缺少必需模型。请放到推荐 models 分类目录，或保留完整 D:/AI/LongCat-Video 目录。",
                unique_id=unique_id,
                model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video",
            )

        components = _resolve_components(模型目录)
        key = tuple(str((components[name] or Path()).resolve()) for name in ("tokenizer", "text_encoder", "vae", "scheduler", "dit", "cfg_lora", "refine_lora")) + (str(精度),)
        if 保持缓存 and key in _PIPE_CACHE:
            return (_PIPE_CACHE[key], "✅ 已复用 LongCat-Video 缓存管线")

        import torch
        from transformers import AutoTokenizer, UMT5EncoderModel
        from longcat_video.modules.autoencoder_kl_wan import AutoencoderKLWan
        from longcat_video.modules.longcat_video_dit import LongCatVideoTransformer3DModel
        from longcat_video.modules.scheduling_flow_match_euler_discrete import FlowMatchEulerDiscreteScheduler
        from longcat_video.pipeline_longcat_video import LongCatVideoPipeline

        device = _device()
        if 精度 == "FP32" or (精度 == "自动" and str(device).startswith("cpu")):
            torch_dtype = torch.float32
        else:
            torch_dtype = torch.bfloat16

        tokenizer = AutoTokenizer.from_pretrained(str(components["tokenizer"]), local_files_only=True, torch_dtype=torch_dtype)
        text_encoder = UMT5EncoderModel.from_pretrained(str(components["text_encoder"]), local_files_only=True, torch_dtype=torch_dtype).eval()
        text_encoder.requires_grad_(False)
        vae = AutoencoderKLWan.from_pretrained(str(components["vae"]), local_files_only=True, torch_dtype=torch_dtype).eval()
        vae.requires_grad_(False)
        scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(str(components["scheduler"]), local_files_only=True, torch_dtype=torch_dtype)
        dit = LongCatVideoTransformer3DModel.from_pretrained(
            str(components["dit"]),
            local_files_only=True,
            torch_dtype=torch_dtype,
            cp_split_hw=[1, 1],
            enable_flashattn3=False,
            enable_flashattn2=False,
            enable_xformers=False,
            enable_bsa=False,
        ).eval()
        dit.requires_grad_(False)

        cfg_lora = components.get("cfg_lora")
        refine_lora = components.get("refine_lora")
        loras_loaded: list[str] = []
        if cfg_lora and cfg_lora.exists():
            dit.load_lora(str(cfg_lora), "cfg_step_lora")
            loras_loaded.append("cfg_step_lora")
        if refine_lora and refine_lora.exists():
            dit.load_lora(str(refine_lora), "refinement_lora")
            loras_loaded.append("refinement_lora")

        pipe = LongCatVideoPipeline(tokenizer=tokenizer, text_encoder=text_encoder, vae=vae, scheduler=scheduler, dit=dit)
        pipe.to(device)
        payload = {
            "pipe": pipe,
            "device": device,
            "dtype": str(torch_dtype).replace("torch.", ""),
            "loras_loaded": loras_loaded,
            "paths": {
                "dit": _path_label(components["dit"]),
                "tokenizer": _path_label(components["tokenizer"]),
                "text_encoder": _path_label(components["text_encoder"]),
                "vae": _path_label(components["vae"]),
                "scheduler": _path_label(components["scheduler"]),
                "cfg_lora": _path_label(cfg_lora) if cfg_lora else "未找到",
                "refine_lora": _path_label(refine_lora) if refine_lora else "未找到",
            },
        }
        if 保持缓存:
            _PIPE_CACHE.clear()
            _PIPE_CACHE[key] = payload
        status = f"✅ LongCat-Video 已加载：{payload['dtype']}，LoRA {len(loras_loaded)} 个。"
        return (payload, status)


class GJJ_LongCatVideoGenerator:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "generate"
    RETURN_TYPES = ("IMAGE", "FLOAT", "STRING")
    RETURN_NAMES = ("视频帧", "帧率", "生成状态")
    OUTPUT_TOOLTIPS = ("生成的视频帧批次，可接入 VHS 或预览节点。", "官方 LongCat-Video 默认 15fps。", "本次生成参数和状态。")
    DESCRIPTION = "使用已加载的 LongCat-Video 管线进行文生视频或图生视频。"
    GJJ_HELP = {
        "description": "连接 LongCat 视频加载器输出。没有参考图时走文生视频；有参考图时可自动走图生视频。蒸馏模式默认 16 步、CFG=1，并使用 cfg_step_lora。",
        "notes": ["输出是 ComfyUI IMAGE 帧批次，可连接 GJJ/VHS 视频合成节点。", "官方 720p/精修会明显增加显存压力。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "longcat管线": ("GJJ_LONGCAT_VIDEO_PIPELINE", {"display_name": "LongCat管线", "tooltip": "连接 LongCat 视频加载器输出。"}),
                "生成模式": (["自动", "文生视频", "图生视频"], {"default": "自动", "display_name": "生成模式", "tooltip": "自动模式：连接参考图则图生视频，否则文生视频。"}),
                "提示词": ("STRING", {"default": "A cinematic realistic video, natural motion, stable composition, detailed lighting", "multiline": True, "display_name": "提示词", "tooltip": "描述视频内容、动作、镜头和风格。"}),
                "随机种": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFF, "display_name": "随机种", "tooltip": "生成随机种。"}),
            },
            "optional": {
                "参考图像": ("IMAGE", {"display_name": "参考图像", "tooltip": "连接后可使用图生视频。"}),
                "负面提示词": ("STRING", {"default": NEGATIVE_PROMPT, "multiline": True, "display_name": "负面提示词", "tooltip": "非蒸馏模式使用；蒸馏模式会按官方默认关闭负面提示词。"}),
                "宽度": ("INT", {"default": 832, "min": 256, "max": 2048, "step": 16, "display_name": "宽度", "tooltip": "文生视频宽度，建议 832。"}),
                "高度": ("INT", {"default": 480, "min": 256, "max": 2048, "step": 16, "display_name": "高度", "tooltip": "文生视频高度，建议 480。"}),
                "图生分辨率": (["480p", "720p"], {"default": "480p", "display_name": "图生分辨率", "tooltip": "图生视频官方分辨率档位。"}),
                "帧数": ("INT", {"default": 93, "min": 17, "max": 201, "step": 4, "display_name": "帧数", "tooltip": "官方默认 93 帧；会自动修正到 VAE 支持的帧数。"}),
                "蒸馏模式": ("BOOLEAN", {"default": True, "display_name": "蒸馏模式", "tooltip": "开启后使用 cfg_step_lora、16 步、CFG=1，速度更快。"}),
                "采样步数": ("INT", {"default": 50, "min": 1, "max": 100, "display_name": "采样步数", "tooltip": "非蒸馏模式采样步数。蒸馏模式固定使用 16 步。"}),
                "引导强度": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 20.0, "step": 0.1, "display_name": "引导强度", "tooltip": "非蒸馏模式 CFG。蒸馏模式固定使用 1。"}),
                "完成后清理缓存": ("BOOLEAN", {"default": True, "display_name": "完成后清理缓存", "tooltip": "完成后释放 PyTorch 缓存；不会卸载加载器缓存中的模型对象。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate(
        self,
        longcat管线,
        生成模式,
        提示词,
        随机种,
        参考图像=None,
        负面提示词=NEGATIVE_PROMPT,
        宽度=832,
        高度=480,
        图生分辨率="480p",
        帧数=93,
        蒸馏模式=True,
        采样步数=50,
        引导强度=4.0,
        完成后清理缓存=True,
        unique_id=None,
    ):
        _ensure_runtime(unique_id=unique_id)
        load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch", unique_id=unique_id)
        import torch

        pipe = longcat管线["pipe"]
        device = longcat管线.get("device") or _device()
        use_image = 参考图像 is not None and 生成模式 != "文生视频"
        if 生成模式 == "图生视频" and 参考图像 is None:
            raise RuntimeError("选择“图生视频”时必须连接参考图像。")
        num_frames = max(17, int(帧数))
        if (num_frames - 1) % 4 != 0:
            num_frames = ((num_frames - 1) // 4) * 4 + 1
        generator = torch.Generator(device=device)
        generator.manual_seed(int(随机种) & 0xFFFFFFFF)
        use_distill = bool(蒸馏模式)
        steps = 16 if use_distill else int(采样步数)
        guidance = 1.0 if use_distill else float(引导强度)
        negative = None if use_distill else str(负面提示词 or "").strip()
        prompt = str(提示词 or "").strip()
        if not prompt:
            raise RuntimeError("提示词不能为空。")
        if use_distill and "cfg_step_lora" not in longcat管线.get("loras_loaded", []):
            raise_dependency_model_error(
                node_name=DISPLAY_GENERATOR,
                missing_models=[make_missing_model_spec("CFG Step LoRA", "models/loras/LongCat-Video", "cfg_step_lora.safetensors", "蒸馏模式需要官方 cfg_step_lora。")],
                description="当前管线未加载 cfg_step_lora，无法使用蒸馏模式。可以关闭蒸馏模式继续。",
                unique_id=unique_id,
                model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video",
            )

        start = time.time()
        try:
            with torch.inference_mode():
                if use_distill:
                    pipe.dit.enable_loras(["cfg_step_lora"])
                if use_image:
                    pil_image = _pil_from_image(参考图像)
                    output = pipe.generate_i2v(
                        image=pil_image,
                        prompt=prompt,
                        negative_prompt=negative,
                        resolution=图生分辨率,
                        num_frames=num_frames,
                        num_inference_steps=steps,
                        use_distill=use_distill,
                        guidance_scale=guidance,
                        generator=generator,
                    )[0]
                else:
                    width = max(256, int(宽度) // 16 * 16)
                    height = max(256, int(高度) // 16 * 16)
                    output = pipe.generate_t2v(
                        prompt=prompt,
                        negative_prompt=negative,
                        height=height,
                        width=width,
                        num_frames=num_frames,
                        num_inference_steps=steps,
                        use_distill=use_distill,
                        guidance_scale=guidance,
                        generator=generator,
                    )[0]
        finally:
            try:
                pipe.dit.disable_all_loras()
            except Exception:
                pass
            if 完成后清理缓存:
                _clear_cache()

        result = _frames_to_tensor(output)
        elapsed = time.time() - start
        mode_label = "图生视频" if use_image else "文生视频"
        status = f"✅ LongCat {mode_label}完成：{result.shape[0]} 帧，15fps，{'蒸馏' if use_distill else '标准'}模式，耗时 {elapsed:.1f}s。"
        return (result, 15.0, status)


NODE_CLASS_MAPPINGS = {
    NODE_LOADER: GJJ_LongCatVideoLoader,
    NODE_GENERATOR: GJJ_LongCatVideoGenerator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_LOADER: DISPLAY_LOADER,
    NODE_GENERATOR: DISPLAY_GENERATOR,
}
