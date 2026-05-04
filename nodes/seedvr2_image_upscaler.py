from __future__ import annotations

import importlib
import sys
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from typing import Any

import torch
from comfy_api.latest import InputImpl, Types
from server import PromptServer


NODE_NAME = "GJJ_SeedVR2ImageUpscaler"
DEFAULT_DIT_MODEL = "seedvr2_ema_3b_fp8_e4m3fn.safetensors"
DEFAULT_VAE_MODEL = "ema_vae_fp16.safetensors"
COMMON_VIDEO_HEIGHT_OPTIONS = [
    "手动输入",
    "480",
    "540",
    "576",
    "720",
    "768",
    "832",
    "960",
    "1024",
    "1080",
    "1216",
    "1440",
    "1536",
    "1920",
    "2160",
]


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _get_local_device_list(include_none: bool = False, include_cpu: bool = False) -> list[str]:
    devices: list[str] = []
    if include_none:
        devices.append("none")
    if include_cpu:
        devices.append("cpu")

    try:
        if torch.cuda.is_available():
            devices.extend([f"cuda:{i}" for i in range(torch.cuda.device_count())])
    except Exception:
        pass

    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            devices.append("mps")
    except Exception:
        pass

    deduped: list[str] = []
    for item in devices:
        if item not in deduped:
            deduped.append(item)
    return deduped or (["cpu"] if include_cpu else ["cpu"])


def _preferred_runtime_device() -> str:
    devices = _get_local_device_list(include_cpu=True)
    if "cuda:0" in devices:
        return "cuda:0"
    return "cpu" if "cpu" in devices else devices[0]


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _get_seedvr2_model_options() -> tuple[list[str], list[str]]:
    dit_models = [DEFAULT_DIT_MODEL]
    vae_models = [DEFAULT_VAE_MODEL]

    try:
        custom_nodes_root = Path(__file__).resolve().parents[2]
        seedvr2_root = custom_nodes_root / "seedvr2_videoupscaler"
        seedvr2_root_str = str(seedvr2_root)
        if seedvr2_root_str not in sys.path:
            sys.path.insert(0, seedvr2_root_str)

        constants = importlib.import_module("src.utils.constants")
        discovered = constants.get_all_model_files()
        for filename in sorted(discovered.keys()):
            lowered = filename.lower()
            if "vae" in lowered:
                if filename not in vae_models:
                    vae_models.append(filename)
            else:
                if filename not in dit_models:
                    dit_models.append(filename)
    except Exception:
        pass

    return dit_models, vae_models


@lru_cache(maxsize=1)
def _get_seedvr2_api() -> dict[str, Any]:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    custom_nodes_root = Path(__file__).resolve().parents[2]
    custom_nodes_root_str = str(custom_nodes_root)
    if custom_nodes_root_str not in sys.path:
        sys.path.insert(0, custom_nodes_root_str)

    seedvr2_root = custom_nodes_root / "seedvr2_videoupscaler"
    seedvr2_root_str = str(seedvr2_root)
    if seedvr2_root_str not in sys.path:
        sys.path.insert(0, seedvr2_root_str)

    try:
        model_registry = importlib.import_module("src.utils.model_registry")
        constants = importlib.import_module("src.utils.constants")
        downloads = importlib.import_module("src.utils.downloads")
        debug_module = importlib.import_module("src.utils.debug")
        generation_phases = importlib.import_module("src.core.generation_phases")
        generation_utils = importlib.import_module("src.core.generation_utils")
        memory_manager = importlib.import_module("src.optimization.memory_manager")
    except Exception as exc:
        raise RuntimeError(
            "无法导入 seedvr2_videoupscaler。"
            "请确认 D:\\AI\\MOD\\custom_nodes\\seedvr2_videoupscaler 存在且依赖已正确安装。"
        ) from exc

    return {
        "DEFAULT_DIT": getattr(model_registry, "DEFAULT_DIT", DEFAULT_DIT_MODEL),
        "DEFAULT_VAE": getattr(model_registry, "DEFAULT_VAE", DEFAULT_VAE_MODEL),
        "get_base_cache_dir": constants.get_base_cache_dir,
        "download_weight": downloads.download_weight,
        "Debug": debug_module.Debug,
        "encode_all_batches": generation_phases.encode_all_batches,
        "upscale_all_batches": generation_phases.upscale_all_batches,
        "decode_all_batches": generation_phases.decode_all_batches,
        "postprocess_all_batches": generation_phases.postprocess_all_batches,
        "setup_generation_context": generation_utils.setup_generation_context,
        "prepare_runner": generation_utils.prepare_runner,
        "compute_generation_info": generation_utils.compute_generation_info,
        "log_generation_start": generation_utils.log_generation_start,
        "load_text_embeddings": generation_utils.load_text_embeddings,
        "script_directory": generation_utils.script_directory,
        "cleanup_text_embeddings": memory_manager.cleanup_text_embeddings,
        "complete_cleanup": memory_manager.complete_cleanup,
        "get_device_list": memory_manager.get_device_list,
    }


def _safe_option_list(getter, fallback: list[str]) -> list[str]:
    try:
        values = list(getter())
    except Exception:
        values = []
    return values or fallback


class GJJ_SeedVR2ImageUpscaler:
    CATEGORY = "GJJ"
    FUNCTION = "upscale_image"
    DESCRIPTION = "将 SeedVR2 的图像/视频放大整合成单节点；接入视频时会自动提取帧、保留原音频与帧率并重建视频。"

    SEARCH_ALIASES = [
        "seedvr2 image upscale",
        "seedvr2 video upscale",
        "seedvr2 upscaler",
        "图片放大",
        "超分",
        "视频放大",
        "seedvr2",
    ]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("放大完成结果",)
    OUTPUT_TOOLTIPS = ("输入图像时输出放大后的图像；输入视频时输出放大后的视频，并自动保留原音频与帧率。",)

    @classmethod
    def INPUT_TYPES(cls):
        devices = _get_local_device_list(include_cpu=True)
        offload_devices = _get_local_device_list(include_none=True, include_cpu=True)
        dit_models, vae_models = _get_seedvr2_model_options()
        preferred_device = _preferred_runtime_device()

        return {
            "required": {
                "common_video_height": (COMMON_VIDEO_HEIGHT_OPTIONS, {
                    "default": "1080",
                    "display_name": "常用视频高度",
                    "tooltip": "常用视频高度快速选择。选中后会覆盖目标分辨率；选“手动输入”时使用右侧手填值。",
                }),
                "resolution": ("INT", {
                    "default": 1080,
                    "min": 16,
                    "max": 16384,
                    "step": 2,
                    "display_name": "目标分辨率",
                    "tooltip": "按最短边目标分辨率放大，并自动保持原图比例。",
                }),
                "max_resolution": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 2,
                    "display_name": "最大分辨率",
                    "tooltip": "限制放大后任一边的最大值；0 表示不限制。",
                }),
                "seed": ("INT", {
                    "default": 42,
                    "min": 0,
                    "max": 2**32 - 1,
                    "display_name": "随机种子",
                    "tooltip": "相同输入和相同参数下，使用同一随机种子可复现结果。",
                }),
                "dit_model": (dit_models, {
                    "default": DEFAULT_DIT_MODEL,
                    "display_name": "放大主模型",
                    "tooltip": "SeedVR2 主超分模型。",
                }),
                "vae_model": (vae_models, {
                    "default": DEFAULT_VAE_MODEL,
                    "display_name": "解码模型",
                    "tooltip": "SeedVR2 编码/解码模型。",
                }),
                "device": (devices, {
                    "default": preferred_device,
                    "display_name": "运行设备",
                    "tooltip": "SeedVR2 推理主设备；如存在 cuda:0，默认自动选中 cuda:0，否则使用 cpu。",
                }),
                "model_offload_device": (offload_devices, {
                    "default": "none" if "none" in offload_devices else offload_devices[0],
                    "display_name": "模型卸载设备",
                    "tooltip": "模型空闲时卸载到的设备；低显存时可设为 cpu。",
                }),
                "tensor_offload_device": (offload_devices, {
                    "default": preferred_device if preferred_device in offload_devices else ("cpu" if "cpu" in offload_devices else offload_devices[0]),
                    "display_name": "张量卸载设备",
                    "tooltip": "中间张量卸载设备；如存在 cuda:0，默认自动选中 cuda:0，否则使用 cpu。",
                }),
                "attention_mode": (["sdpa", "flash_attn_2", "flash_attn_3", "sageattn_2", "sageattn_3"], {
                    "default": "sdpa",
                    "display_name": "注意力模式",
                    "tooltip": "默认 sdpa 最稳；其它模式依赖你的显卡和环境支持。",
                }),
                "blocks_to_swap": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 36,
                    "display_name": "模块交换数量",
                    "tooltip": "低显存优化参数；0 表示关闭。开启时建议同时设置模型卸载设备。",
                }),
                "swap_io_components": ("BOOLEAN", {
                    "default": False,
                    "display_name": "卸载IO组件",
                    "tooltip": "进一步降低显存占用，但可能降低速度。",
                }),
                "encode_tiled": ("BOOLEAN", {
                    "default": True,
                    "display_name": "分块编码",
                    "tooltip": "降低 VAE 编码显存占用。",
                }),
                "encode_tile_size": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 8192,
                    "step": 32,
                    "display_name": "编码分块大小",
                    "tooltip": "VAE 编码阶段的分块大小。",
                }),
                "encode_tile_overlap": ("INT", {
                    "default": 128,
                    "min": 0,
                    "max": 2048,
                    "step": 32,
                    "display_name": "编码分块重叠",
                    "tooltip": "VAE 编码阶段的分块重叠。",
                }),
                "decode_tiled": ("BOOLEAN", {
                    "default": True,
                    "display_name": "分块解码",
                    "tooltip": "降低 VAE 解码显存占用。",
                }),
                "decode_tile_size": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 8192,
                    "step": 32,
                    "display_name": "解码分块大小",
                    "tooltip": "VAE 解码阶段的分块大小。",
                }),
                "decode_tile_overlap": ("INT", {
                    "default": 128,
                    "min": 0,
                    "max": 2048,
                    "step": 32,
                    "display_name": "解码分块重叠",
                    "tooltip": "VAE 解码阶段的分块重叠。",
                }),
                "tile_debug": (["false", "encode", "decode"], {
                    "default": "false",
                    "display_name": "分块调试显示",
                    "tooltip": "调试 VAE 分块边界；正常使用建议保持 false。",
                }),
                "color_correction": (["lab", "wavelet", "wavelet_adaptive", "hsv", "adain", "none"], {
                    "default": "lab",
                    "display_name": "色彩校正",
                    "tooltip": "让放大后的颜色更接近原图；lab 通常最稳。",
                }),
                "input_noise_scale": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.001,
                    "display_name": "输入噪声强度",
                    "tooltip": "对输入图注入微量噪声以缓和压缩瑕疵；默认 0。",
                }),
                "latent_noise_scale": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.001,
                    "display_name": "潜空间噪声强度",
                    "tooltip": "对潜空间结果注入微量噪声；默认 0。",
                }),
                "enable_debug": ("BOOLEAN", {
                    "default": False,
                    "display_name": "开启调试模式",
                    "tooltip": "打印 SeedVR2 的详细执行和显存日志。",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "display_name": "输入图像",
                    "tooltip": "输入单张或批量图像进行 SeedVR2 放大。",
                }),
                "video": ("VIDEO", {
                    "display_name": "输入视频",
                    "tooltip": "输入视频后会自动提取帧，放大后按原视频帧率与音频重建。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def upscale_image(
        self,
        common_video_height,
        resolution,
        max_resolution,
        seed,
        dit_model,
        vae_model,
        device,
        model_offload_device,
        tensor_offload_device,
        attention_mode,
        blocks_to_swap,
        swap_io_components,
        encode_tiled,
        encode_tile_size,
        encode_tile_overlap,
        decode_tiled,
        decode_tile_size,
        decode_tile_overlap,
        tile_debug,
        color_correction,
        input_noise_scale,
        latent_noise_scale,
        enable_debug,
        image=None,
        video=None,
        unique_id=None,
    ):
        api = _get_seedvr2_api()
        Debug = api["Debug"]
        debug = Debug(enabled=enable_debug)

        selected_common_height = str(common_video_height or "手动输入").strip()
        if selected_common_height and selected_common_height != "手动输入":
            try:
                resolution = int(selected_common_height)
            except Exception:
                pass

        if (blocks_to_swap > 0 or swap_io_components) and model_offload_device == "none":
            raise RuntimeError("启用模块交换或 IO 组件卸载时，请同时设置“模型卸载设备”。")

        runner = None
        ctx = None
        pbar = None

        def progress_callback(current_step: int, total_steps: int, current_frames: int, phase_name: str) -> None:
            if pbar is None:
                return

            phase_weights = {
                "阶段 1: 编码": 0.2,
                "阶段 2: 放大": 0.25,
                "阶段 3: 解码": 0.5,
                "阶段 4: 后处理": 0.05,
            }
            phase_offset = {
                "阶段 1: 编码": 0.0,
                "阶段 2: 放大": 0.2,
                "阶段 3: 解码": 0.45,
                "阶段 4: 后处理": 0.95,
            }

            phase_key = phase_name.split(" (")[0] if " (" in phase_name else phase_name
            weight = phase_weights.get(phase_key, 1.0)
            offset = phase_offset.get(phase_key, 0.0)
            phase_progress = (current_step / total_steps) if total_steps > 0 else 0.0
            pbar.update_absolute(int((offset + phase_progress * weight) * 100), 100)
            _send_status(unique_id, f"{phase_name}：{current_step}/{total_steps}")

        def cleanup() -> None:
            nonlocal runner, ctx
            if runner is not None:
                api["complete_cleanup"](runner=runner, debug=debug, dit_cache=False, vae_cache=False)
                runner = None
            if ctx is not None:
                api["cleanup_text_embeddings"](ctx, debug)
                ctx = None

        if video is not None:
            try:
                _send_status(unique_id, "1/6 获取视频元素...")
                components = video.get_components()
                image = components.images
                source_audio = components.audio
                source_fps = float(components.frame_rate)
                output_mode = "video"
            except Exception as exc:
                raise RuntimeError("无法从输入视频中提取帧、音频或帧率。") from exc
        else:
            source_audio = None
            source_fps = None
            output_mode = "image"

        if image is None:
            raise RuntimeError("请至少连接“输入图像”或“输入视频”其中之一。")

        model_offload = torch.device(model_offload_device) if model_offload_device != "none" else None
        tensor_offload = torch.device(tensor_offload_device) if tensor_offload_device != "none" else None
        run_device = torch.device(device)

        block_swap_config = None
        if blocks_to_swap > 0 or swap_io_components:
            block_swap_config = {
                "blocks_to_swap": int(blocks_to_swap),
                "swap_io_components": bool(swap_io_components),
            }
            if model_offload is not None:
                block_swap_config["offload_device"] = model_offload

        _send_status(unique_id, "2/6 检查并下载 SeedVR2 模型...")
        api["download_weight"](dit_model=dit_model, vae_model=vae_model, debug=debug)

        try:
            try:
                from comfy.utils import ProgressBar
            except Exception:
                ProgressBar = None

            if ProgressBar is not None:
                pbar = ProgressBar(100)

            _send_status(unique_id, "3/6 准备运行环境...")
            ctx = api["setup_generation_context"](
                dit_device=run_device,
                vae_device=run_device,
                dit_offload_device=model_offload,
                vae_offload_device=model_offload,
                tensor_offload_device=tensor_offload,
                debug=debug,
            )

            runner, cache_context = api["prepare_runner"](
                dit_model=dit_model,
                vae_model=vae_model,
                model_dir=api["get_base_cache_dir"](),
                debug=debug,
                ctx=ctx,
                dit_cache=False,
                vae_cache=False,
                dit_id=None,
                vae_id=None,
                block_swap_config=block_swap_config,
                encode_tiled=bool(encode_tiled),
                encode_tile_size=(int(encode_tile_size), int(encode_tile_size)),
                encode_tile_overlap=(int(encode_tile_overlap), int(encode_tile_overlap)),
                decode_tiled=bool(decode_tiled),
                decode_tile_size=(int(decode_tile_size), int(decode_tile_size)),
                decode_tile_overlap=(int(decode_tile_overlap), int(decode_tile_overlap)),
                tile_debug=str(tile_debug),
                attention_mode=str(attention_mode),
                torch_compile_args_dit=None,
                torch_compile_args_vae=None,
            )

            ctx["cache_context"] = cache_context
            ctx["text_embeds"] = api["load_text_embeddings"](
                api["script_directory"],
                ctx["dit_device"],
                ctx["compute_dtype"],
                debug,
            )

            _send_status(unique_id, "4/6 计算放大计划...")
            image, gen_info = api["compute_generation_info"](
                ctx=ctx,
                images=image,
                resolution=int(resolution),
                max_resolution=int(max_resolution),
                batch_size=1,
                uniform_batch_size=False,
                seed=int(seed),
                prepend_frames=0,
                temporal_overlap=0,
                debug=debug,
            )
            api["log_generation_start"](gen_info, debug)

            _send_status(unique_id, "5/6 执行 SeedVR2 放大...")
            ctx = api["encode_all_batches"](
                runner,
                ctx=ctx,
                images=image,
                debug=debug,
                batch_size=1,
                uniform_batch_size=False,
                seed=int(seed),
                progress_callback=progress_callback,
                temporal_overlap=0,
                resolution=int(resolution),
                max_resolution=int(max_resolution),
                input_noise_scale=float(input_noise_scale),
                color_correction=str(color_correction),
            )

            ctx = api["upscale_all_batches"](
                runner,
                ctx=ctx,
                debug=debug,
                progress_callback=progress_callback,
                seed=int(seed),
                latent_noise_scale=float(latent_noise_scale),
                cache_model=False,
            )

            ctx = api["decode_all_batches"](
                runner,
                ctx=ctx,
                debug=debug,
                progress_callback=progress_callback,
                cache_model=False,
            )

            ctx = api["postprocess_all_batches"](
                ctx=ctx,
                debug=debug,
                progress_callback=progress_callback,
                color_correction=str(color_correction),
                prepend_frames=0,
                temporal_overlap=0,
                batch_size=1,
            )

            sample = ctx["final_video"]
            if torch.is_tensor(sample):
                if sample.is_cuda or sample.is_mps:
                    sample = sample.cpu()
                if sample.dtype != torch.float32:
                    sample = sample.to(torch.float32)

            cleanup()
            pbar = None
            if output_mode == "video":
                _send_status(unique_id, "6/6 创建视频...")
                video_output = InputImpl.VideoFromComponents(
                    Types.VideoComponents(
                        images=sample,
                        audio=source_audio,
                        frame_rate=Fraction(source_fps if source_fps and source_fps > 0 else 24.0),
                    )
                )
                _send_status(unique_id, f"完成：视频 {int(sample.shape[2])} × {int(sample.shape[1])}")
                return (video_output,)

            _send_status(unique_id, f"完成：图像 {int(sample.shape[2])} × {int(sample.shape[1])}")
            return (sample,)
        except Exception:
            cleanup()
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SeedVR2ImageUpscaler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔍 SeedVR2图像视频放大器"}
