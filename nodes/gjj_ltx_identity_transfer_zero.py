from __future__ import annotations

import copy
import logging
import types
from typing import Any

import torch
import torch.nn.functional as F


NODE_NAME = "GJJ_LTXIdentityTransfer"
NODE_DISPLAY_NAME = "GJJ · 🧬 LTX身份迁移"

log = logging.getLogger("GJJ_LTXIdentityTransfer")
_DEBUG_ENABLED = False
PROJECTOR_NONE_VALUES = {"", "None", "none", "不使用"}
ARCFACE_MODE_MAP = {
    "关闭": "disable",
    "自动调整": "auto_adjust",
    "原图检测": "as_is",
    "disable": "disable",
    "auto_adjust": "auto_adjust",
    "as_is": "as_is",
}
REF_RESIZE_MODE_MAP = {
    "保持参考图原始分辨率": "native_resolution",
    "匹配目标视频分辨率": "match_target",
    "native_resolution": "native_resolution",
    "match_target": "match_target",
}


def _dbg(*parts: Any) -> None:
    if _DEBUG_ENABLED:
        print("[GJJ LTX身份迁移] " + " ".join(str(part) for part in parts), flush=True)


def _shape(value: Any) -> str:
    try:
        if hasattr(value, "shape"):
            return f"T{tuple(value.shape)}"
        if isinstance(value, (list, tuple)):
            return f"{type(value).__name__}[{', '.join(_shape(item) for item in value)}]"
        return type(value).__name__
    except Exception:
        return "?"


def _find_ltx_diffusion_model(model: Any) -> Any:
    current = getattr(model, "model", model)
    return getattr(current, "diffusion_model", current)


def _latent_to_pixel_coords(latent_coords: torch.Tensor, scale_factors: Any, causal_fix: bool) -> torch.Tensor:
    try:
        from comfy.ldm.lightricks.model import latent_to_pixel_coords

        return latent_to_pixel_coords(
            latent_coords=latent_coords,
            scale_factors=scale_factors,
            causal_fix=causal_fix,
        )
    except Exception as exc:
        raise RuntimeError(
            "当前 ComfyUI 的 LTX 模型接口缺少 latent_to_pixel_coords，无法安装 LTX 身份迁移补丁。"
        ) from exc


def _rotate_tail_rope_freqs(pe: Any, ref_len: int, phase_value: float, theta: float = 10000.0) -> Any:
    if ref_len <= 0 or float(phase_value) == 0.0:
        return pe
    cos, sin = pe[0], pe[1]
    rest = tuple(pe[2:])
    dim = int(cos.shape[-1])
    index = torch.arange(dim, device=cos.device, dtype=torch.float32)
    phase = float(phase_value) * (float(theta) ** (-index / float(dim)))
    phase_cos = phase.cos().to(dtype=cos.dtype)
    phase_sin = phase.sin().to(dtype=sin.dtype)

    tail = [slice(None)] * cos.dim()
    tail[-2] = slice(int(cos.shape[-2]) - int(ref_len), int(cos.shape[-2]))
    tail = tuple(tail)

    old_cos = cos[tail]
    old_sin = sin[tail]
    cos = cos.clone()
    sin = sin.clone()
    cos[tail] = old_cos * phase_cos - old_sin * phase_sin
    sin[tail] = old_sin * phase_cos + old_cos * phase_sin
    return (cos, sin, *rest)


def _install_overlap_patch(ltx_model: Any) -> None:
    if getattr(ltx_model, "_gjj_id_overlap_patched", False):
        return

    missing = [
        name
        for name in ("_process_input", "_prepare_timestep", "_prepare_positional_embeddings", "_process_output")
        if not hasattr(ltx_model, name)
    ]
    if missing:
        raise RuntimeError(
            "输入 MODEL 不是可补丁的 LTX/LTXV 模型，缺少接口：" + ", ".join(missing)
        )

    original_process_input = ltx_model._process_input
    original_prepare_timestep = ltx_model._prepare_timestep
    original_prepare_pe = ltx_model._prepare_positional_embeddings
    original_process_output = ltx_model._process_output

    def process_input(self, x, keyframe_idxs, denoise_mask, **kwargs):
        output = original_process_input(x, keyframe_idxs, denoise_mask, **kwargs)
        ref_latent = kwargs.get("_gjj_id_ref_latent")
        if ref_latent is None:
            self._gjj_id_ref_len = 0
            return output

        try:
            hidden, pixel_coords, extra = output
            is_av = isinstance(hidden, (list, tuple))
            video_hidden = hidden[0] if is_av else hidden
            video_coords = pixel_coords[0] if is_av else pixel_coords

            ref_tokens, ref_latent_coords = self.patchifier.patchify(
                ref_latent.to(device=video_hidden.device, dtype=video_hidden.dtype)
            )
            ref_pixel_coords = _latent_to_pixel_coords(
                ref_latent_coords,
                getattr(self, "vae_scale_factors", None),
                bool(getattr(self, "causal_temporal_positioning", False)),
            )
            ref_tokens = self.patchify_proj(ref_tokens)

            if ref_tokens.shape[0] != video_hidden.shape[0]:
                ref_tokens = ref_tokens.expand(video_hidden.shape[0], -1, -1)
            if ref_pixel_coords.shape[0] != video_coords.shape[0]:
                ref_pixel_coords = ref_pixel_coords.expand(video_coords.shape[0], *([-1] * (ref_pixel_coords.dim() - 1)))

            ref_len = int(ref_tokens.shape[1])
            self._gjj_id_target_len = int(video_hidden.shape[1])
            self._gjj_id_ref_len = ref_len

            video_hidden = torch.cat([video_hidden, ref_tokens], dim=1)
            video_coords = torch.cat([video_coords, ref_pixel_coords.to(video_coords)], dim=2)
            extra = dict(extra)
            extra["_gjj_id_ref_len"] = ref_len

            if is_av:
                hidden = [video_hidden, *list(hidden[1:])]
                pixel_coords = [video_coords, *list(pixel_coords[1:])]
            else:
                hidden = video_hidden
                pixel_coords = video_coords

            _dbg("process_input ref_len", ref_len, "hidden", _shape(hidden), "coords", _shape(pixel_coords))
            return hidden, pixel_coords, extra
        except Exception as exc:
            _dbg("process_input failed", repr(exc), "output", _shape(output), "ref", _shape(ref_latent))
            raise

    def prepare_timestep(self, timestep, batch_size, hidden_dtype, **kwargs):
        ref_len = int(getattr(self, "_gjj_id_ref_len", 0) or 0)
        target_len = getattr(self, "_gjj_id_target_len", None)
        if ref_len and target_len is not None:
            if timestep.dim() <= 1:
                timestep = timestep.view(-1, 1).expand(batch_size, int(target_len)).contiguous()
            if timestep.dim() >= 2:
                current_len = int(timestep.shape[1])
                grid_mask = kwargs.get("grid_mask")
                grid_len = int(grid_mask.shape[-1]) if grid_mask is not None and hasattr(grid_mask, "shape") else None
                if grid_len is not None and current_len == grid_len:
                    ref_timestep = torch.zeros(batch_size, ref_len, *timestep.shape[2:], device=timestep.device, dtype=timestep.dtype)
                    timestep = torch.cat([timestep, ref_timestep], dim=1)
                elif current_len > int(target_len) + ref_len:
                    timestep = timestep[:, : int(target_len)]
                    current_len = int(target_len)
                if (grid_len is None or int(timestep.shape[1]) != grid_len + ref_len) and current_len == int(target_len):
                    ref_timestep = torch.zeros(batch_size, ref_len, *timestep.shape[2:], device=timestep.device, dtype=timestep.dtype)
                    timestep = torch.cat([timestep, ref_timestep], dim=1)

                grid_mask = kwargs.get("grid_mask")
                if grid_mask is not None and hasattr(grid_mask, "shape"):
                    gap = int(timestep.shape[1]) - int(grid_mask.shape[-1])
                    if 0 < gap <= ref_len:
                        kwargs = dict(kwargs)
                        pad = torch.ones(*grid_mask.shape[:-1], gap, dtype=grid_mask.dtype, device=grid_mask.device)
                        kwargs["grid_mask"] = torch.cat([grid_mask, pad], dim=-1)
            _dbg("prepare_timestep", _shape(timestep))
        return original_prepare_timestep(timestep, batch_size, hidden_dtype, **kwargs)

    def prepare_positional_embeddings(self, pixel_coords, frame_rate, x_dtype):
        pe = original_prepare_pe(pixel_coords, frame_rate, x_dtype)
        ref_len = int(getattr(self, "_gjj_id_ref_len", 0) or 0)
        if not ref_len:
            return pe
        phase_value = float(getattr(self, "_gjj_id_phase_value", 2.0))
        theta = float(getattr(self, "_gjj_id_rope_theta", 10000.0))
        if isinstance(pe, list) and pe and isinstance(pe[0], (list, tuple)) and isinstance(pe[0][0], (list, tuple)):
            video_pe, cross_video = pe[0][0], pe[0][1]
            return [(_rotate_tail_rope_freqs(video_pe, ref_len, phase_value, theta), cross_video), *list(pe[1:])]
        return _rotate_tail_rope_freqs(pe, ref_len, phase_value, theta)

    def process_output(self, x, embedded_timestep, keyframe_idxs, **kwargs):
        ref_len = int(getattr(self, "_gjj_id_ref_len", 0) or 0)
        if ref_len:
            try:
                try:
                    from comfy.ldm.lightricks.av_model import CompressedTimestep
                except Exception:
                    CompressedTimestep = ()

                if isinstance(x, (list, tuple)):
                    x = [x[0][:, : x[0].shape[1] - ref_len], *list(x[1:])]
                    timestep_items = list(embedded_timestep) if isinstance(embedded_timestep, (list, tuple)) else [embedded_timestep]
                    video_timestep = timestep_items[0]
                    if CompressedTimestep and isinstance(video_timestep, CompressedTimestep):
                        patches_per_frame = max(1, int(getattr(video_timestep, "patches_per_frame", 1) or 1))
                        ref_frames = max(1, ref_len // patches_per_frame)
                        replacement = copy.copy(video_timestep)
                        replacement.data = video_timestep.data[:, : video_timestep.num_frames - ref_frames].contiguous()
                        replacement.num_frames = video_timestep.num_frames - ref_frames
                        timestep_items[0] = replacement
                    elif hasattr(video_timestep, "shape") and video_timestep.dim() >= 2 and video_timestep.shape[1] > 1:
                        timestep_items[0] = video_timestep[:, : video_timestep.shape[1] - ref_len]
                    embedded_timestep = timestep_items
                else:
                    x = x[:, : x.shape[1] - ref_len]
                    if hasattr(embedded_timestep, "shape") and embedded_timestep.dim() >= 2 and embedded_timestep.shape[1] > 1:
                        embedded_timestep = embedded_timestep[:, : embedded_timestep.shape[1] - ref_len]
                _dbg("process_output", _shape(x), _shape(embedded_timestep))
            except Exception as exc:
                _dbg("process_output failed", repr(exc), "x", _shape(x), "t", _shape(embedded_timestep))
                raise
        return original_process_output(x, embedded_timestep, keyframe_idxs, **kwargs)

    ltx_model._process_input = types.MethodType(process_input, ltx_model)
    ltx_model._prepare_timestep = types.MethodType(prepare_timestep, ltx_model)
    ltx_model._prepare_positional_embeddings = types.MethodType(prepare_positional_embeddings, ltx_model)
    ltx_model._process_output = types.MethodType(process_output, ltx_model)
    ltx_model._gjj_id_overlap_patched = True


def _normalize_ref_image(image: torch.Tensor) -> torch.Tensor:
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"reference_face 必须是 IMAGE 张量 [B,H,W,C]，当前形状为 {tuple(image.shape)}。")
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    elif image.shape[-1] >= 3:
        image = image[..., :3]
    else:
        raise RuntimeError(f"reference_face 通道数无效：{tuple(image.shape)}。")
    return image[:1].float().clamp(0.0, 1.0).contiguous()


def _encode_reference(vae: Any, latent: dict[str, Any], reference_face: torch.Tensor, ref_resize_mode: str) -> tuple[torch.Tensor, int, int]:
    import comfy.utils

    reference_face = _normalize_ref_image(reference_face)
    try:
        _time_scale, width_scale, height_scale = vae.downscale_index_formula
    except Exception as exc:
        raise RuntimeError("输入 VAE 缺少 LTX downscale_index_formula，无法计算参考图编码尺寸。") from exc

    width_scale = int(width_scale)
    height_scale = int(height_scale)
    if ref_resize_mode == "native_resolution":
        _batch, src_h, src_w, _channels = reference_face.shape
        target_w = max(width_scale, round(int(src_w) / width_scale) * width_scale)
        target_h = max(height_scale, round(int(src_h) / height_scale) * height_scale)
        crop = "disabled"
    else:
        samples = latent.get("samples")
        if samples is None or samples.ndim != 5:
            raise RuntimeError("latent 必须包含 5D LTX samples：[B,C,T,H,W]。")
        _batch, _channels, _frames, latent_h, latent_w = samples.shape
        target_w = int(latent_w) * width_scale
        target_h = int(latent_h) * height_scale
        crop = "center"

    ref_pixels = comfy.utils.common_upscale(
        reference_face.movedim(-1, 1),
        int(target_w),
        int(target_h),
        "bilinear",
        crop,
    ).movedim(1, -1)[:, :, :, :3]
    return vae.encode(ref_pixels), int(target_w), int(target_h)


def _append_context_tokens(conditioning: list[Any], tokens: torch.Tensor) -> list[Any]:
    output = []
    for cond, meta in conditioning:
        token_tensor = tokens.to(device=cond.device, dtype=cond.dtype)
        if token_tensor.shape[0] != cond.shape[0]:
            token_tensor = token_tensor.expand(cond.shape[0], -1, -1)
        if token_tensor.shape[-1] < cond.shape[-1]:
            token_tensor = F.pad(token_tensor, (0, cond.shape[-1] - token_tensor.shape[-1]))
        elif token_tensor.shape[-1] > cond.shape[-1]:
            token_tensor = token_tensor[..., : cond.shape[-1]]
        new_meta = dict(meta)
        attention_mask = new_meta.get("attention_mask")
        if attention_mask is not None:
            ones = torch.ones((*attention_mask.shape[:-1], token_tensor.shape[1]), device=attention_mask.device, dtype=attention_mask.dtype)
            new_meta["attention_mask"] = torch.cat([attention_mask, ones], dim=-1)
        output.append([torch.cat([cond, token_tensor], dim=1), new_meta])
    return output


class GJJ_LTXIdentityTransfer:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "apply"
    DESCRIPTION = "LTX 身份迁移：把参考图编码为独立参考标记，并用来源相位标记注入 LTX 模型，用于人物身份参考视频生成。"
    SEARCH_ALIASES = ["LTX Identity Transfer", "LTX Face ID", "LTX identity overlap", "Best Face ID", "身份迁移", "人物一致性"]
    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT", "STRING")
    RETURN_NAMES = ("模型", "正向条件", "负向条件", "视频潜空间", "调试信息")
    OUTPUT_TOOLTIPS = (
        "已注入参考图身份迁移补丁的 LTX 模型，接到采样器的模型输入。",
        "正向条件原样输出；当身份投影器不可用时，仅使用参考图潜空间注入身份信息。",
        "负向条件原样输出；当身份投影器不可用时，不追加额外身份标记。",
        "原样透传的视频潜空间；参考图会在模型运行时注入，不直接改写潜空间。",
        "本次参考图编码尺寸、来源相位和补丁状态。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths

            projector_choices = ["不使用"] + [str(name) for name in folder_paths.get_filename_list("loras")]
        except Exception:
            projector_choices = ["不使用"]
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "输入已加载 LTX 身份模型补丁或身份 LoRA 的 LTX/LTXV 模型。"}),
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "输入采样器使用的正向条件。节点会保持条件结构不变，并把参考图身份信息注入模型侧。"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件", "tooltip": "输入采样器使用的负向条件。节点会保持条件结构不变。"}),
                "vae": ("VAE", {"display_name": "视频编码器", "tooltip": "用于把参考图编码成 LTX 潜空间的视频编码器。"}),
                "latent": ("LATENT", {"display_name": "视频潜空间", "tooltip": "目标视频潜空间，用于确定目标分辨率；输出会原样透传。"}),
                "reference_face": ("IMAGE", {"display_name": "参考人物图", "tooltip": "用于迁移身份的人物参考图。建议使用清晰、正面或接近正面的人脸/半身图；角色表可配合原始分辨率模式。"}),
                "identity_projector": (projector_choices, {"default": "不使用", "display_name": "身份投影器", "tooltip": "可选的身份投影器模型。当前 GJJ 单节点默认不使用该项，主要依靠参考图潜空间进行身份迁移。"}),
                "source_id": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 16.0, "step": 1.0, "display_name": "来源编号", "tooltip": "参考图的来源相位编号。通常保持 2；多个参考来源时可用不同编号区分。0 表示不添加额外来源相位。"}),
                "phase_scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 8.0, "step": 0.1, "display_name": "相位强度", "tooltip": "来源相位的缩放倍率。通常保持 1.0；调高会增强参考标记，也可能带来不稳定。"}),
                "id_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 50.0, "step": 0.5, "display_name": "身份强度", "tooltip": "身份投影器标记的强度。未使用身份投影器时，此参数仅保留为工作流兼容项。"}),
                "arcface_mode": (["关闭", "自动调整", "原图检测"], {"default": "关闭", "display_name": "人脸检测模式", "tooltip": "身份投影器的人脸检测模式。当前单节点默认关闭；关闭时只使用参考图潜空间注入身份。"}),
                "ref_resize_mode": (["保持参考图原始分辨率", "匹配目标视频分辨率"], {"default": "保持参考图原始分辨率", "display_name": "参考图缩放", "tooltip": "保持参考图原始分辨率适合角色表和固定参考图尺寸；匹配目标视频分辨率适合普通近景人脸参考。"}),
                "debug_log": ("BOOLEAN", {"default": False, "display_name": "输出调试日志", "tooltip": "开启后在控制台打印参考标记、位置编码和输出裁剪等调试信息。"}),
            },
        }

    def apply(
        self,
        model,
        positive,
        negative,
        vae,
        latent,
        reference_face,
        identity_projector="None",
        source_id=2.0,
        phase_scale=1.0,
        id_strength=1.0,
        arcface_mode="关闭",
        ref_resize_mode="保持参考图原始分辨率",
        debug_log=False,
    ):
        global _DEBUG_ENABLED
        _DEBUG_ENABLED = bool(debug_log)
        arcface_mode = ARCFACE_MODE_MAP.get(str(arcface_mode), "disable")
        ref_resize_mode = REF_RESIZE_MODE_MAP.get(str(ref_resize_mode), "native_resolution")

        patched_model = model.clone()
        ltx_model = _find_ltx_diffusion_model(patched_model)
        ref_latent, target_w, target_h = _encode_reference(vae, latent, reference_face, ref_resize_mode)
        _install_overlap_patch(ltx_model)

        ltx_model._gjj_id_phase_value = float(source_id) * float(phase_scale)
        ltx_model._gjj_id_rope_theta = 10000.0

        patched_model.model_options = dict(getattr(patched_model, "model_options", {}) or {})
        transformer_options = dict(patched_model.model_options.get("transformer_options", {}) or {})
        transformer_options["_gjj_id_ref_latent"] = ref_latent
        patched_model.model_options["transformer_options"] = transformer_options

        projector_status = "不使用：仅通过参考图潜空间迁移身份"
        use_projector = str(identity_projector or "不使用") not in PROJECTOR_NONE_VALUES
        if use_projector and str(arcface_mode) != "disable":
            projector_status = "已跳过：当前单节点不加载外部人脸检测器或投影器"
        elif use_projector:
            projector_status = "已跳过：人脸检测模式为关闭"

        debug = (
            "=== GJJ LTX 身份迁移 ===\n"
            f"参考图潜空间：{list(ref_latent.shape)} | 编码尺寸：{target_w}x{target_h}px | 缩放模式：{ref_resize_mode}\n"
            f"来源相位：来源编号 {float(source_id)} * 相位强度 {float(phase_scale)} -> {float(source_id) * float(phase_scale)}\n"
            f"身份投影器：{projector_status} | 身份强度：{id_strength}\n"
            f"补丁目标：{type(ltx_model).__name__} | 视频潜空间原样透传"
        )
        log.info("\n%s", debug)
        return patched_model, positive, negative, latent, debug


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXIdentityTransfer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
