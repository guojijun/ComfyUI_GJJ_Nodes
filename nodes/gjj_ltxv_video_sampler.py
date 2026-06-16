from __future__ import annotations

import gc
import base64
import io
import re
import time
from typing import Any

import comfy.model_management
import comfy.nested_tensor
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import torch


NODE_NAME = "GJJ_LTXVVideoSampler"


class _WidgetCompatibleInput(str):
    def __new__(cls, display_type: str, allowed_types: tuple[str, ...]):
        instance = super().__new__(cls, display_type)
        instance.allowed_types = set(allowed_types)
        return instance

    def __ne__(self, other):
        if "*" in self.allowed_types or other == "*":
            return False
        return str(other) not in self.allowed_types


noise_seed_input = _WidgetCompatibleInput("INT", ("INT", "NOISE"))
sigmas_input = _WidgetCompatibleInput("STRING", ("STRING", "SIGMAS"))


def _sampler_names() -> list[str]:
    names = list(getattr(comfy.samplers, "SAMPLER_NAMES", []) or [])
    if names:
        return names
    names = list(getattr(comfy.samplers.KSampler, "SAMPLERS", []) or [])
    return names or ["euler", "euler_cfg_pp"]


def _as_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_float(value: Any, default: float, min_value: float, max_value: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _send_clear_status(unique_id: Any) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": "", "progress": 1.0, "clear_status": True},
        )
    except Exception:
        pass


def _pil_to_data_url(image: Any, fmt: str = "JPEG", max_edge: int = 512) -> str:
    if image is None:
        return ""
    try:
        img = image.copy()
        img.thumbnail((max_edge, max_edge))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buffer = io.BytesIO()
        image_format = "PNG" if str(fmt).upper() == "PNG" else "JPEG"
        save_kwargs = {"quality": 82} if image_format == "JPEG" else {}
        img.save(buffer, format=image_format, **save_kwargs)
        mime = "image/png" if image_format == "PNG" else "image/jpeg"
        return f"data:{mime};base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"
    except Exception:
        return ""


def _send_sampling_preview(
    unique_id: Any,
    image_data_url: str,
    step: int,
    total_steps: int,
    progress: float,
) -> None:
    if not unique_id or not image_data_url:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_ltxv_sampler_preview",
            {
                "node": str(unique_id),
                "image": image_data_url,
                "step": int(step),
                "total": int(total_steps),
                "progress": max(0.0, min(1.0, float(progress))),
            },
        )
    except Exception:
        pass


def _preview_video_latent(value: Any) -> Any:
    try:
        if isinstance(value, comfy.nested_tensor.NestedTensor):
            parts = value.unbind()
            return parts[0] if parts else value
    except Exception:
        pass
    return value


def _decode_preview_payload(previewer: Any, preview_format: str, latent_value: Any) -> tuple[Any | None, str]:
    if previewer is None or latent_value is None:
        return None, ""
    try:
        preview_latent = _preview_video_latent(latent_value)
        preview_bytes = previewer.decode_latent_to_preview_image(preview_format, preview_latent)
        fmt, image, max_edge = preview_bytes
        return preview_bytes, _pil_to_data_url(image, fmt, max_edge)
    except Exception:
        return None, ""


def _make_sampling_callback(model_patcher: Any, steps: int, x0_output: dict[str, Any] | None, unique_id: Any):
    preview_format = "JPEG"
    previewer = latent_preview.get_previewer(model_patcher.load_device, model_patcher.model.latent_format)
    pbar = comfy.utils.ProgressBar(steps)
    last_sent = 0.0

    def callback(step, x0, x, total_steps):
        nonlocal last_sent
        if x0_output is not None:
            x0_output["x0"] = x0

        preview_bytes = None
        image_data_url = ""
        if previewer:
            try:
                now = time.monotonic()
                is_last = int(step) + 1 >= int(total_steps)
                if is_last or now - last_sent >= 0.35:
                    preview_bytes, image_data_url = _decode_preview_payload(previewer, preview_format, x0)
                    last_sent = now
            except Exception:
                preview_bytes = None
                image_data_url = ""

        pbar.update_absolute(step + 1, total_steps, preview_bytes)
        if image_data_url:
            progress = (int(step) + 1) / max(1, int(total_steps))
            _send_sampling_preview(unique_id, image_data_url, int(step) + 1, int(total_steps), progress)

    return callback


def _send_initial_sampling_preview(model_patcher: Any, latent_value: Any, unique_id: Any, total_steps: int) -> None:
    if not unique_id:
        return
    try:
        previewer = latent_preview.get_previewer(model_patcher.load_device, model_patcher.model.latent_format)
        _preview_bytes, image_data_url = _decode_preview_payload(previewer, "JPEG", latent_value)
        if image_data_url:
            _send_sampling_preview(unique_id, image_data_url, 0, max(1, int(total_steps)), 0.0)
    except Exception:
        pass


def _parse_sigmas_text(sigmas: str) -> torch.Tensor:
    values = re.findall(r"[-+]?(?:\d*\.*\d+)", str(sigmas or ""))
    if not values:
        raise RuntimeError("LTX视频采样器：Sigmas 不能为空，例如 0.85, 0.7250, 0.4219, 0.0。")
    parsed = [float(item) for item in values]
    if len(parsed) < 2:
        raise RuntimeError("LTX视频采样器：Sigmas 至少需要两个数值。")
    return torch.FloatTensor(parsed)


def _normalize_sigmas(sigmas) -> torch.Tensor:
    if sigmas is not None:
        if isinstance(sigmas, torch.Tensor):
            tensor = sigmas.detach().to(dtype=torch.float32).flatten().cpu()
        elif isinstance(sigmas, str):
            return _parse_sigmas_text(sigmas)
        elif isinstance(sigmas, (list, tuple)):
            tensor = torch.tensor([float(item) for item in sigmas], dtype=torch.float32).flatten()
        else:
            tensor = torch.as_tensor(sigmas, dtype=torch.float32).flatten().cpu()
        if int(tensor.numel()) < 2:
            raise RuntimeError("LTX视频采样器：外接 SIGMAS 至少需要两个数值。")
        return tensor
    return _parse_sigmas_text("")


def _resolve_noise(noise_seed, latent: dict[str, Any]):
    if hasattr(noise_seed, "generate_noise"):
        return noise_seed.generate_noise(latent)
    if isinstance(noise_seed, dict) and callable(noise_seed.get("generate_noise")):
        return noise_seed["generate_noise"](latent)
    seed = _as_int(noise_seed, 42, 0, 0xffffffffffffffff)
    return _RandomNoise(seed).generate_noise(latent)


def _shape_text(value: Any) -> str:
    try:
        if isinstance(value, comfy.nested_tensor.NestedTensor):
            shapes = []
            for item in value.unbind():
                shapes.append("x".join(str(int(dim)) for dim in item.shape))
            return " + ".join(shapes) if shapes else "未知"
        if hasattr(value, "shape"):
            return "x".join(str(int(dim)) for dim in value.shape)
    except Exception:
        pass
    return "未知"


def _latent_summary(video_latent: dict[str, Any], audio_latent: dict[str, Any], latent_image: Any = None) -> str:
    video_shape = _shape_text((video_latent or {}).get("samples") if isinstance(video_latent, dict) else None)
    audio_shape = _shape_text((audio_latent or {}).get("samples") if isinstance(audio_latent, dict) else None)
    merged_shape = _shape_text(latent_image)
    parts = [f"视频 latent: {video_shape}", f"音频 latent: {audio_shape}"]
    if merged_shape != "未知":
        parts.append(f"合并后 latent: {merged_shape}")
    return "；".join(parts)


def _gpu_memory_summary() -> str:
    try:
        if not torch.cuda.is_available():
            return ""
        device = torch.cuda.current_device()
        total = torch.cuda.get_device_properties(device).total_memory / (1024**3)
        allocated = torch.cuda.memory_allocated(device) / (1024**3)
        reserved = torch.cuda.memory_reserved(device) / (1024**3)
        free, _total = torch.cuda.mem_get_info(device)
        return f"GPU显存：总计 {total:.2f} GiB，已分配 {allocated:.2f} GiB，已保留 {reserved:.2f} GiB，当前空闲 {free / (1024**3):.2f} GiB。"
    except Exception:
        return ""


def _make_oom_message(exc: BaseException, video_latent: dict[str, Any], audio_latent: dict[str, Any], latent_image: Any) -> str:
    latent_text = _latent_summary(video_latent, audio_latent, latent_image)
    memory_text = _gpu_memory_summary()
    source_text = str(exc).splitlines()[0].strip()
    tips = [
        "LTX视频采样器：显存不足，采样已中断并尝试清理缓存。",
        f"当前输入：{latent_text}。",
    ]
    if memory_text:
        tips.append(memory_text)
    if source_text:
        tips.append(f"PyTorch提示：{source_text}")
    tips.extend(
        [
            "建议处理：优先把上游视频 latent 的宽高降一档，或减少帧数/时长；确认 batch_size 为 1；关闭本节点「输出降噪Latent」；如仍不足，换更低分辨率预设或减少参考/控制条件。",
            "这次报错不是 Sigmas 或采样器名称问题，而是当前 latent 尺寸对应的单步模型前向显存超过了显卡上限。",
        ]
    )
    return "\n".join(tips)


class _RandomNoise:
    def __init__(self, seed: int):
        self.seed = seed

    def generate_noise(self, input_latent: dict[str, Any]):
        latent_image = input_latent["samples"]
        batch_inds = input_latent["batch_index"] if "batch_index" in input_latent else None
        return comfy.sample.prepare_noise(latent_image, self.seed, batch_inds)


def _concat_av_latent(video_latent: dict[str, Any], audio_latent: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(video_latent, dict) or "samples" not in video_latent:
        raise RuntimeError("LTX视频采样器：视频 latent 输入缺少 samples。")
    if not isinstance(audio_latent, dict) or "samples" not in audio_latent:
        raise RuntimeError("LTX视频采样器：音频 latent 输入缺少 samples。")

    output = {}
    output.update(video_latent)
    output.update(audio_latent)

    video_noise_mask = video_latent.get("noise_mask", None)
    audio_noise_mask = audio_latent.get("noise_mask", None)
    if video_noise_mask is not None or audio_noise_mask is not None:
        if video_noise_mask is None:
            video_noise_mask = torch.ones_like(video_latent["samples"])
        if audio_noise_mask is None:
            audio_noise_mask = torch.ones_like(audio_latent["samples"])
        output["noise_mask"] = comfy.nested_tensor.NestedTensor((video_noise_mask, audio_noise_mask))

    output["samples"] = comfy.nested_tensor.NestedTensor((video_latent["samples"], audio_latent["samples"]))
    return output


def _cleanup_cuda() -> None:
    gc.collect()
    try:
        comfy.model_management.soft_empty_cache()
    except TypeError:
        comfy.model_management.soft_empty_cache(force=True)
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
    except Exception:
        pass


def _offload_model(model: Any) -> None:
    try:
        offload_device = comfy.model_management.unet_offload_device()
    except Exception:
        offload_device = None
    if offload_device is None:
        return

    candidates = [
        model,
        getattr(model, "model", None),
        getattr(getattr(model, "model", None), "diffusion_model", None),
        getattr(model, "diffusion_model", None),
    ]
    seen: set[int] = set()
    for item in candidates:
        if item is None:
            continue
        key = id(item)
        if key in seen:
            continue
        seen.add(key)
        try:
            if hasattr(item, "to"):
                item.to(offload_device)
        except Exception:
            pass


class GJJ_LTXVVideoSampler:
    @classmethod
    def INPUT_TYPES(cls):
        samplers = _sampler_names()
        default_sampler = "euler_cfg_pp" if "euler_cfg_pp" in samplers else samplers[0]
        return {
            "required": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "模型",
                        "tooltip": "连接 LTX/LTXV 模型。内部会构造 CFGGuider。",
                    },
                ),
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "正向提示词条件，等同原 CFGGuider 的 positive 输入。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负向条件",
                        "tooltip": "负向提示词条件，等同原 CFGGuider 的 negative 输入。",
                    },
                ),
                "video_latent": (
                    "LATENT",
                    {
                        "display_name": "视频Latent",
                        "tooltip": "视频 latent，内部会与音频 latent 合并为 LTXV AV latent。",
                    },
                ),
                "audio_latent": (
                    "LATENT",
                    {
                        "display_name": "音频Latent",
                        "tooltip": "音频 latent，内部会与视频 latent 合并为 LTXV AV latent。",
                    },
                ),
                "noise_seed": (
                    noise_seed_input,
                    {
                        "default": 42,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "control_after_generate": True,
                        "display_name": "噪波种子",
                        "tooltip": "可直接输入种子，也可连接 RandomNoise 输出的 NOISE；外接 NOISE 时优先使用外部噪波对象。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "CFG",
                        "tooltip": "等同原 CFGGuider 的 cfg。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": default_sampler,
                        "display_name": "K采样器",
                        "tooltip": "等同原 KSamplerSelect 的 sampler_name。",
                    },
                ),
                "sigmas": (
                    sigmas_input,
                    {
                        "default": "0.85, 0.7250, 0.4219, 0.0",
                        "multiline": False,
                        "display_name": "Sigmas",
                        "tooltip": "可手填逗号/空格分隔的 Sigmas，也可连接基本调度器/BasicScheduler 输出的 SIGMAS。",
                    },
                ),
                "auto_clean_memory": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "采样后清内存",
                        "tooltip": "采样完成后主动断开中间引用、卸载采样模型并清理 Comfy/PyTorch 缓存。关闭后连续采样会更快，但内存会保留更多。",
                    },
                ),
                "output_denoised": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "输出降噪Latent",
                        "tooltip": "开启后额外保存 x0 并生成第二个降噪 Latent 输出，会明显增加视频任务的系统内存占用；关闭时第二输出复用采样 Latent。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("采样Latent", "降噪Latent")
    OUTPUT_TOOLTIPS = ("SamplerCustomAdvanced 的 output。", "SamplerCustomAdvanced 的 denoised_output。")
    FUNCTION = "sample"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "把 RandomNoise、CFGGuider、KSamplerSelect、ManualSigmas、LTXVConcatAVLatent、SamplerCustomAdvanced 合并成一个 LTX 视频采样器。"
    GJJ_HELP = {
        "title": "LTX 视频采样器",
        "description": "零依赖 GJJ 单节点，内部复刻六个原生节点串联：随机噪波、CFG 引导器、K 采样器选择、自定义 Sigmas、LTXV 音视频 latent 合并和高级自定义采样。",
        "usage": [
            "输入模型、正负条件、视频 latent、音频 latent。",
            "噪波支持 INT 种子或外接 NOISE；Sigmas 支持手填 STRING 或外接基本调度器 SIGMAS。",
            "默认不额外生成降噪 Latent，以减少视频采样后的系统内存占用；需要第二输出时可打开「输出降噪Latent」。",
            "输出与 SamplerCustomAdvanced 一致：采样 Latent 和降噪 Latent。",
        ],
    }

    def sample(
        self,
        model,
        positive,
        negative,
        video_latent,
        audio_latent,
        noise_seed,
        cfg,
        sampler_name,
        sigmas,
        auto_clean_memory,
        output_denoised,
        unique_id=None,
    ):
        guider = None
        latent = None
        latent_image = None
        noise_mask = None
        x0_output = None
        callback = None
        resolved_noise = None
        samples = None
        x0_out = None
        out = None
        out_denoised = None
        completed = False

        _send_status(unique_id, "1/5 准备 LTXV 采样参数...", 0.08)
        seed = _as_int(noise_seed, 42, 0, 0xffffffffffffffff)
        cfg = _as_float(cfg, 1.0, 0.0, 100.0)
        sigmas_tensor = _normalize_sigmas(sigmas)
        sampler = comfy.samplers.sampler_object(str(sampler_name))

        _send_status(unique_id, "2/5 构建 CFG 引导器...", 0.18)
        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(positive, negative)
        guider.set_cfg(cfg)

        _send_status(unique_id, "3/5 合并音视频 Latent...", 0.32)
        latent = _concat_av_latent(video_latent, audio_latent)
        latent_image = comfy.sample.fix_empty_latent_channels(
            guider.model_patcher,
            latent["samples"],
            latent.get("downscale_ratio_spacial", None),
        )
        latent = latent.copy()
        latent["samples"] = latent_image
        noise_mask = latent.get("noise_mask", None)

        output_denoised = bool(output_denoised)
        x0_output = {} if output_denoised else None
        callback = _make_sampling_callback(guider.model_patcher, sigmas_tensor.shape[-1] - 1, x0_output, unique_id)
        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

        try:
            _send_status(unique_id, "4/5 采样生成 LTXV Latent...", 0.48)
            _cleanup_cuda()
            resolved_noise = _resolve_noise(noise_seed, latent)
            _send_initial_sampling_preview(guider.model_patcher, resolved_noise, unique_id, int(sigmas_tensor.shape[-1]) - 1)
            samples = guider.sample(
                resolved_noise,
                latent_image,
                sampler,
                sigmas_tensor,
                denoise_mask=noise_mask,
                callback=callback,
                disable_pbar=disable_pbar,
                seed=seed,
            )
            samples = samples.to(comfy.model_management.intermediate_device())

            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out["samples"] = samples

            if output_denoised and isinstance(x0_output, dict) and "x0" in x0_output:
                x0_out = guider.model_patcher.model.process_latent_out(x0_output["x0"].cpu())
                if samples.is_nested:
                    latent_shapes = [x.shape for x in samples.unbind()]
                    x0_out = comfy.nested_tensor.NestedTensor(comfy.utils.unpack_latents(x0_out, latent_shapes))
                out_denoised = latent.copy()
                out_denoised.pop("downscale_ratio_spacial", None)
                out_denoised["samples"] = x0_out
            else:
                out_denoised = out

            _send_status(unique_id, "5/5 LTXV 采样完成", 1.0)
            completed = True
            return (out, out_denoised)
        except torch.OutOfMemoryError as exc:
            _send_status(unique_id, "LTXV采样显存不足，正在清理缓存...", 1.0)
            try:
                model_patcher = getattr(guider, "model_patcher", None)
                _offload_model(model_patcher)
            except Exception:
                pass
            _cleanup_cuda()
            raise RuntimeError(_make_oom_message(exc, video_latent, audio_latent, latent_image)) from exc
        finally:
            try:
                if isinstance(x0_output, dict):
                    x0_output.clear()
            except Exception:
                pass
            callback = None
            resolved_noise = None
            samples = None
            x0_out = None
            latent_image = None
            noise_mask = None
            latent = None
            out = None
            out_denoised = None
            if bool(auto_clean_memory):
                _send_status(unique_id, "正在清理采样缓存...", 0.98)
                try:
                    model_patcher = getattr(guider, "model_patcher", None)
                    _offload_model(model_patcher)
                except Exception:
                    pass
                guider = None
                _cleanup_cuda()
            if completed:
                _send_clear_status(unique_id)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVVideoSampler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ LTX视频采样器"}
