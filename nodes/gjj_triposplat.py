from __future__ import annotations

import importlib
import importlib.util
import contextlib
import os
from pathlib import Path
import sys
import time
import types
import uuid
from typing import Any

import numpy as np
from PIL import Image
import torch

import folder_paths

from .common_utils.model_manager import gjjutils_resolve_model_by_extensionless_seed
from .common_utils.progress import send_node_progress
from .common_utils.temp_files import gjjutils_write_temp_tensor_images

NODE_AIO = "GJJ_TripoSplatImageToSplat"
NODE_RENDER = "GJJ_TripoSplatRenderSequence"

MODEL_SEEDS = {
    "diffusion_models": "triposplat_fp16.safetensors",
    "clip_vision": "dino_v3_vit_h.safetensors",
    "vae_triposplat": "triposplat_vae_decoder_fp16.safetensors",
    "vae_flux2": "flux2-vae.safetensors",
}

_TRIPOSPLAT_CORE_PATCHED = False
_VRAM_POLICY_ENV = "GJJ_TRIPOSPLAT_VRAM_FIRST"


def _import_triposplat_vendor_module(module_name: str):
    relative_name = f"..vendor.gjj_triposplat_runtime.{module_name}"
    try:
        return importlib.import_module(relative_name, __package__)
    except Exception:
        package_root = Path(__file__).resolve().parents[1]
        root_text = str(package_root)
        if root_text not in sys.path:
            sys.path.insert(0, root_text)
        return importlib.import_module(f"vendor.gjj_triposplat_runtime.{module_name}")


def _get_mesh_batch_item(mesh: Any, index: int):
    save_3d = _import_triposplat_vendor_module("nodes_save_3d")
    return save_3d.get_mesh_batch_item(mesh, index)


def _save_glb(*args, **kwargs):
    save_3d = _import_triposplat_vendor_module("nodes_save_3d")
    return save_3d.save_glb(*args, **kwargs)


def _make_file3d(path: str, file_format: str):
    _install_comfy_api_latest_compat()
    try:
        latest = importlib.import_module("comfy_api.latest")
        file3d_cls = getattr(getattr(latest, "Types", None), "File3D", None)
    except Exception:
        file3d_cls = None
    if file3d_cls is None:
        raise RuntimeError("TripoSplat GLB 导出失败：当前 ComfyUI 缺少 File3D 类型。")
    return file3d_cls(path, file_format=file_format)


def _hidden_option(options: dict[str, Any]) -> dict[str, Any]:
    data = dict(options)
    data.setdefault("forceInput", False)
    return data


def _is_vram_first(policy: str) -> bool:
    return str(policy or "").strip() != "自动"


def _triposplat_compute_device():
    import comfy.model_management

    if os.environ.get(_VRAM_POLICY_ENV) == "1":
        device = comfy.model_management.get_torch_device()
        if not comfy.model_management.is_device_cpu(device):
            return device
    return None


@contextlib.contextmanager
def _triposplat_vram_policy(policy: str):
    previous = os.environ.get(_VRAM_POLICY_ENV)
    if _is_vram_first(policy):
        os.environ[_VRAM_POLICY_ENV] = "1"
    else:
        os.environ.pop(_VRAM_POLICY_ENV, None)
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(_VRAM_POLICY_ENV, None)
        else:
            os.environ[_VRAM_POLICY_ENV] = previous


def _install_comfy_api_latest_compat() -> None:
    class _NodeOutput:
        def __init__(self, *args, ui=None, expand=None, block_execution=None):
            self.args = args
            self.ui = ui
            self.expand = expand
            self.block_execution = block_execution

        @property
        def result(self):
            return self.args if self.args else None

        def __getitem__(self, index):
            return self.args[index]

    class _SPLAT:
        def __init__(self, positions, scales, rotations, opacities, sh, counts=None):
            self.positions = positions
            self.scales = scales
            self.rotations = rotations
            self.opacities = opacities
            self.sh = sh
            self.counts = counts

    class _MESH:
        def __init__(self, vertices, faces, uvs=None, vertex_colors=None, texture=None, vertex_counts=None, face_counts=None, unlit=False):
            self.vertices = vertices
            self.faces = faces
            self.uvs = uvs
            self.vertex_colors = vertex_colors
            self.texture = texture
            self.vertex_counts = vertex_counts
            self.face_counts = face_counts
            self.unlit = unlit

    class _File3D:
        def __init__(self, stream, file_format=None, **_kwargs):
            self.stream = stream
            self.format = file_format or getattr(stream, "format", "") or ""

        def get_bytes(self) -> bytes:
            if hasattr(self.stream, "getvalue"):
                return self.stream.getvalue()
            data = self.stream.read()
            return data if isinstance(data, bytes) else bytes(data)

        def save_to(self, path: str) -> None:
            with open(path, "wb") as file:
                file.write(self.get_bytes())

    try:
        latest = importlib.import_module("comfy_api.latest")
        io_obj = getattr(latest, "IO", None)
        if io_obj is not None and not hasattr(io_obj, "NodeOutput"):
            setattr(io_obj, "NodeOutput", _NodeOutput)
        if io_obj is not None and not hasattr(io_obj, "ComfyNode"):
            setattr(io_obj, "ComfyNode", object)
        if not hasattr(latest, "ComfyExtension"):
            latest.ComfyExtension = type("ComfyExtension", (), {})
        types_obj = getattr(latest, "Types", None)
        if types_obj is None:
            types_obj = types.SimpleNamespace()
            latest.Types = types_obj
        if not hasattr(types_obj, "SPLAT"):
            setattr(types_obj, "SPLAT", _SPLAT)
        if not hasattr(types_obj, "MESH"):
            setattr(types_obj, "MESH", _MESH)
        if not hasattr(types_obj, "File3D"):
            setattr(types_obj, "File3D", _File3D)
        return
    except Exception:
        pass

    if "comfy_api.latest" in sys.modules:
        latest = sys.modules["comfy_api.latest"]
        types_obj = getattr(latest, "Types", types.SimpleNamespace())
        latest.Types = types_obj
        if not hasattr(types_obj, "SPLAT"):
            setattr(types_obj, "SPLAT", _SPLAT)
        if not hasattr(types_obj, "MESH"):
            setattr(types_obj, "MESH", _MESH)
        if not hasattr(types_obj, "File3D"):
            setattr(types_obj, "File3D", _File3D)
        return

    class _ComfyExtension:
        pass

    class _ComfyNode:
        pass

    class _IOType:
        @staticmethod
        def Input(*_args, **_kwargs):
            return None

        @staticmethod
        def Output(*_args, **_kwargs):
            return None

    class _DynamicCombo(_IOType):
        @staticmethod
        def Option(name, inputs=None):
            return {"name": name, "inputs": inputs or []}

    class _Autogrow:
        Type = list

        @staticmethod
        def TemplatePrefix(*_args, **_kwargs):
            return None

        @staticmethod
        def Input(*_args, **_kwargs):
            return None

    class _IO:
        ComfyNode = _ComfyNode
        NodeOutput = _NodeOutput
        Schema = lambda *args, **kwargs: {"args": args, "kwargs": kwargs}
        Hidden = types.SimpleNamespace(prompt="PROMPT", extra_pnginfo="EXTRA_PNGINFO", unique_id="UNIQUE_ID")
        Image = Mask = Int = Float = Combo = Color = Splat = File3DSplatAny = File3DAny = File3DPLY = File3DSPLAT = File3DKSPLAT = File3DSPZ = Mesh = String = Load3DCamera = Model = Vae = ClipVision = Conditioning = Latent = _IOType
        File3DGLB = File3DGLTF = File3DOBJ = File3DFBX = File3DSTL = File3DUSDZ = File3DPointCloudAny = _IOType
        MultiType = _IOType
        DynamicCombo = _DynamicCombo
        Autogrow = _Autogrow

    latest = types.ModuleType("comfy_api.latest")
    latest.ComfyExtension = _ComfyExtension
    latest.IO = _IO
    latest.Types = types.SimpleNamespace(SPLAT=_SPLAT, MESH=_MESH, File3D=_File3D)
    package = types.ModuleType("comfy_api")
    package.latest = latest
    sys.modules.setdefault("comfy_api", package)
    sys.modules["comfy_api.latest"] = latest


def _runtime_modules():
    try:
        _install_comfy_api_latest_compat()
        triposplat = importlib.import_module("..vendor.gjj_triposplat_runtime.nodes_triposplat", __package__)
        splat = importlib.import_module("..vendor.gjj_triposplat_runtime.nodes_gaussian_splat", __package__)
        return triposplat, splat
    except Exception as exc:
        raise RuntimeError(f"TripoSplat 本地运行时加载失败：{exc}") from exc


def _register_module_alias(alias: str, module: Any) -> None:
    sys.modules[alias] = module
    parent_name, _, child_name = alias.rpartition(".")
    if parent_name:
        parent = sys.modules.get(parent_name)
        if parent is not None:
            setattr(parent, child_name, module)


def _patch_triposplat_core_support() -> None:
    global _TRIPOSPLAT_CORE_PATCHED
    if _TRIPOSPLAT_CORE_PATCHED:
        return
    _install_comfy_api_latest_compat()
    import comfy.ldm
    import comfy.latent_formats
    import comfy.model_base
    import comfy.model_detection
    import comfy.supported_models
    import comfy.supported_models_base

    pkg = importlib.import_module("..vendor.gjj_triposplat_runtime.ldm_triposplat", __package__)
    gaussian = importlib.import_module("..vendor.gjj_triposplat_runtime.ldm_triposplat.gaussian", __package__)
    model_mod = importlib.import_module("..vendor.gjj_triposplat_runtime.ldm_triposplat.model", __package__)
    preview_mod = importlib.import_module("..vendor.gjj_triposplat_runtime.ldm_triposplat.preview", __package__)
    vae_mod = importlib.import_module("..vendor.gjj_triposplat_runtime.ldm_triposplat.vae", __package__)

    if not hasattr(comfy.ldm, "triposplat"):
        setattr(comfy.ldm, "triposplat", pkg)
    _register_module_alias("comfy.ldm.triposplat", pkg)
    _register_module_alias("comfy.ldm.triposplat.gaussian", gaussian)
    _register_module_alias("comfy.ldm.triposplat.model", model_mod)
    _register_module_alias("comfy.ldm.triposplat.preview", preview_mod)
    _register_module_alias("comfy.ldm.triposplat.vae", vae_mod)

    if not hasattr(comfy.latent_formats, "TripoSplat"):
        class TripoSplatLatent(comfy.latent_formats.LatentFormat):
            latent_channels = 16

            def process_in(self, latent):
                return latent

            def process_out(self, latent):
                return latent

        TripoSplatLatent.__name__ = "TripoSplat"
        setattr(comfy.latent_formats, "TripoSplat", TripoSplatLatent)

    if not hasattr(comfy.model_base, "TripoSplat"):
        class TripoSplatBase(comfy.model_base.BaseModel):
            def __init__(self, model_config, model_type=comfy.model_base.ModelType.FLOW, device=None):
                super().__init__(model_config, model_type, device=device, unet_model=model_mod.LatentSeqMMFlowModel)

            def extra_conds(self, **kwargs):
                out = super().extra_conds(**kwargs)
                cross_attn = kwargs.get("cross_attn", None)
                if cross_attn is not None:
                    out["c_crossattn"] = comfy.conds.CONDRegular(cross_attn)
                ref_latents = kwargs.get("reference_latents", None)
                if ref_latents is not None:
                    out["ref_latents"] = comfy.conds.CONDList(list(ref_latents))
                latent_shapes = kwargs.get("latent_shapes", None)
                if latent_shapes is not None:
                    out["latent_shapes"] = comfy.conds.CONDConstant(latent_shapes)
                return out

        TripoSplatBase.__name__ = "TripoSplat"
        setattr(comfy.model_base, "TripoSplat", TripoSplatBase)

    if not any(getattr(cls, "__name__", "") == "TripoSplat" for cls in comfy.supported_models.models):
        class TripoSplatSupported(comfy.supported_models_base.BASE):
            unet_config = {"image_model": "triposplat"}
            unet_extra_config = {}
            sampling_settings = {"shift": 3.0}
            memory_usage_factor = 0.6
            latent_format = comfy.latent_formats.TripoSplat
            supported_inference_dtypes = [torch.float16, torch.bfloat16, torch.float32]

            def get_model(self, state_dict, prefix="", device=None):
                return comfy.model_base.TripoSplat(self, device=device)

            def clip_target(self, state_dict={}):
                return None

        TripoSplatSupported.__name__ = "TripoSplat"
        comfy.supported_models.models.insert(0, TripoSplatSupported)

    if not getattr(comfy.model_detection, "_gjj_triposplat_detect_patched", False):
        original_detect = comfy.model_detection.detect_unet_config

        def detect_unet_config_patched(state_dict, key_prefix, *args, **kwargs):
            keys = set(state_dict.keys())
            if f"{key_prefix}cam_out_layer.weight" in keys and f"{key_prefix}repo_layers.0.final_map.weight" in keys:
                return {"image_model": "triposplat"}
            return original_detect(state_dict, key_prefix, *args, **kwargs)

        comfy.model_detection.detect_unet_config = detect_unet_config_patched
        comfy.model_detection._gjj_triposplat_detect_patched = True

    _TRIPOSPLAT_CORE_PATCHED = True


def _core_nodes():
    try:
        return importlib.import_module("nodes")
    except Exception as exc:
        raise RuntimeError(f"ComfyUI 原生节点模块加载失败：{exc}") from exc


def _node_output_value(value: Any, index: int = 0) -> Any:
    if hasattr(value, "args"):
        return value.args[index]
    if isinstance(value, dict) and "result" in value:
        return value["result"][index]
    return value[index]


def _coerce_image_tensor(media: Any) -> torch.Tensor:
    if isinstance(media, torch.Tensor):
        image = media
    elif isinstance(media, dict):
        image = None
        for key in ("images", "image", "frames"):
            value = media.get(key)
            if isinstance(value, torch.Tensor):
                image = value
                break
    else:
        image = getattr(media, "images", None)
        if not isinstance(image, torch.Tensor):
            image = getattr(media, "image", None)
    if not isinstance(image, torch.Tensor):
        raise ValueError("请连接 IMAGE 或 GJJ_BATCH_IMAGE 图片输入。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError(f"图片张量维度异常：{tuple(image.shape)}")
    return image[..., :3].contiguous()


def _preview_ui(images: torch.Tensor, prefix: str) -> dict[str, Any]:
    try:
        return {"images": gjjutils_write_temp_tensor_images(images[..., :3].detach().cpu())}
    except Exception:
        return {}


def _resolve_required_models() -> dict[str, str]:
    resolved = {
        "unet": gjjutils_resolve_model_by_extensionless_seed(MODEL_SEEDS["diffusion_models"], "diffusion_models"),
        "clip_vision": gjjutils_resolve_model_by_extensionless_seed(MODEL_SEEDS["clip_vision"], "clip_vision"),
        "vae_triposplat": gjjutils_resolve_model_by_extensionless_seed(MODEL_SEEDS["vae_triposplat"], "vae"),
        "vae_flux2": gjjutils_resolve_model_by_extensionless_seed(MODEL_SEEDS["vae_flux2"], "vae"),
    }
    missing = [key for key, value in resolved.items() if not value]
    if missing:
        names = {
            "unet": "models/diffusion_models/triposplat_fp16.safetensors",
            "clip_vision": "models/clip_vision/dino_v3_vit_h.safetensors",
            "vae_triposplat": "models/vae/triposplat_vae_decoder_fp16.safetensors",
            "vae_flux2": "models/vae/flux2-vae.safetensors",
        }
        lines = "\n".join(f"  - {names[key]}" for key in missing)
        raise RuntimeError(f"未找到 TripoSplat 必需模型：\n{lines}\n已按去扩展名、去量化标记规则在 models 子目录中搜索。")
    return {k: str(v) for k, v in resolved.items()}


def _load_triposplat_decoder_vae(vae_name: str, unique_id=None):
    _patch_triposplat_core_support()
    import comfy.model_management
    import comfy.model_patcher
    import comfy.utils
    import folder_paths

    _, splat_runtime = _runtime_modules()
    vae_mod = importlib.import_module("comfy.ldm.triposplat.vae")
    path = folder_paths.get_full_path_or_raise("vae", vae_name)
    send_node_progress(unique_id, "加载 TripoSplat 高斯解码器...", 0.23)
    state_dict = comfy.utils.load_torch_file(path)
    decoder = vae_mod.OctreeGaussianDecoder().eval()
    preferred_device = _triposplat_compute_device()
    device = preferred_device or comfy.model_management.vae_device()
    offload_device = preferred_device or comfy.model_management.vae_offload_device()
    dtype = comfy.model_management.vae_dtype(device, [torch.float16, torch.bfloat16, torch.float32])
    decoder.to(dtype)
    patcher_cls = getattr(comfy.model_patcher, "CoreModelPatcher", comfy.model_patcher.ModelPatcher)
    patcher = patcher_cls(decoder, load_device=device, offload_device=offload_device)
    assign = patcher.is_dynamic() if hasattr(patcher, "is_dynamic") else False
    missing, unexpected = decoder.load_state_dict(state_dict, strict=False, assign=assign)
    if missing:
        print(f"[GJJ TripoSplat] TripoSplat VAE 缺少权重键：{missing[:8]}{' ...' if len(missing) > 8 else ''}")
    if unexpected:
        print(f"[GJJ TripoSplat] TripoSplat VAE 额外权重键：{unexpected[:8]}{' ...' if len(unexpected) > 8 else ''}")
    try:
        comfy.model_management.archive_model_dtypes(decoder)
    except Exception:
        pass
    return types.SimpleNamespace(
        first_stage_model=decoder,
        patcher=patcher,
        device=device,
        vae_dtype=dtype,
        latent_channels=16,
        latent_dim=1,
    )


def _load_dinov3_clip_vision(clip_name: str, unique_id=None):
    import comfy.model_management
    import comfy.model_patcher
    import comfy.ops
    import comfy.utils
    import folder_paths

    dino3 = importlib.import_module("..vendor.gjj_triposplat_runtime.dino3", __package__)
    path = folder_paths.get_full_path_or_raise("clip_vision", clip_name)
    send_node_progress(unique_id, "加载本地 DINOv3 ViT-H 图像编码器...", 0.20)
    state_dict = comfy.utils.load_torch_file(path)
    if "layer.0.mlp.gate_proj.weight" not in state_dict or "layer.31.norm1.weight" not in state_dict:
        raise RuntimeError("DINOv3 模型权重结构不匹配，请确认使用 models/clip_vision/dino_v3_vit_h.safetensors。")
    preferred_device = _triposplat_compute_device()
    load_device = preferred_device or comfy.model_management.text_encoder_device()
    offload_device = preferred_device or comfy.model_management.text_encoder_offload_device()
    dtype = comfy.model_management.text_encoder_dtype(load_device)
    model = dino3.DINOv3ViTModel(dino3.DINOV3_VITH_CONFIG, dtype, offload_device, comfy.ops.manual_cast).eval()
    patcher_cls = getattr(comfy.model_patcher, "CoreModelPatcher", comfy.model_patcher.ModelPatcher)
    patcher = patcher_cls(model, load_device=load_device, offload_device=offload_device)
    assign = patcher.is_dynamic() if hasattr(patcher, "is_dynamic") else False
    missing, unexpected = model.load_state_dict(state_dict, strict=False, assign=assign)
    if missing:
        print(f"[GJJ TripoSplat] DINOv3 缺少权重键：{missing[:8]}{' ...' if len(missing) > 8 else ''}")
    if unexpected:
        print(f"[GJJ TripoSplat] DINOv3 额外权重键：{unexpected[:8]}{' ...' if len(unexpected) > 8 else ''}")
    return types.SimpleNamespace(
        model=model,
        patcher=patcher,
        load_device=load_device,
        offload_device=offload_device,
        dtype=dtype,
    )


def _load_models(unique_id=None):
    _patch_triposplat_core_support()
    nodes_mod = _core_nodes()
    names = _resolve_required_models()
    send_node_progress(unique_id, "加载 TripoSplat UNET...", 0.16)
    try:
        model = nodes_mod.UNETLoader().load_unet(names["unet"], "default")[0]
    except Exception as exc:
        raise RuntimeError(f"加载 TripoSplat UNET 失败：{exc}") from exc
    clip_vision = _load_dinov3_clip_vision(names["clip_vision"], unique_id=unique_id)
    send_node_progress(unique_id, "加载 Flux2 VAE 和 TripoSplat VAE...", 0.24)
    vae_flux2 = nodes_mod.VAELoader().load_vae(names["vae_flux2"])[0]
    vae_triposplat = _load_triposplat_decoder_vae(names["vae_triposplat"], unique_id=unique_id)
    return model, clip_vision, vae_flux2, vae_triposplat


def _remove_background_rmbg14(image: torch.Tensor, unique_id=None) -> tuple[torch.Tensor, torch.Tensor]:
    try:
        from .gjj_comprehensive_matting import GJJ_ComprehensiveMatting, METHOD_RMBG14
    except Exception as exc:
        raise RuntimeError(f"RMBG1.4 抠图模块加载失败：{exc}") from exc
    send_node_progress(unique_id, "RMBG1.4 正在去除背景...", 0.08)
    result = GJJ_ComprehensiveMatting().remove_background(
        matting_method=METHOD_RMBG14,
        background="透明",
        device="自动",
        process_res=1024,
        threshold=0.0,
        mask_blur=0.0,
        invert_output=False,
        media=image,
        unique_id=unique_id,
    )
    rgba = _node_output_value(result, 0)
    mask = _node_output_value(result, 1)
    if not isinstance(rgba, torch.Tensor) or not isinstance(mask, torch.Tensor):
        raise RuntimeError("RMBG1.4 抠图输出异常：未返回图片和遮罩张量。")
    return rgba, mask


def _make_camera_info(splat_module: Any, yaw: float, pitch: float, distance: float, fov: float, unique_id=None):
    mode = {"mode": "orbit", "yaw": float(yaw), "pitch": float(pitch), "distance": float(distance)}
    send_node_progress(unique_id, "创建相机信息...", 0.12)
    return _node_output_value(splat_module.CreateCameraInfo.execute(
        mode=mode,
        target_x=0.0,
        target_y=0.0,
        target_z=0.0,
        roll=0.0,
        fov=float(fov),
        zoom=1.0,
        camera_type="perspective",
    ))


def _mesh_to_glb_file3d(mesh: Any, unique_id=None):
    if not hasattr(mesh, "vertices") or not hasattr(mesh, "faces"):
        raise TypeError("TripoSplat GLB 导出失败：网格对象缺少 vertices/faces。")

    texture_b = getattr(mesh, "texture", None)
    texture_np = None
    if texture_b is not None:
        texture_np = (texture_b.clamp(0.0, 1.0).detach().cpu().numpy() * 255).astype(np.uint8)
        if texture_np.ndim != 4 or texture_np.shape[-1] != 3:
            raise ValueError(f"TripoSplat GLB 导出失败：贴图必须是 (B, H, W, 3) RGB，实际形状：{tuple(texture_np.shape)}")

    batch_count = int(mesh.vertices.shape[0])
    for index in range(batch_count):
        vertices_i, faces_i, colors_i, uvs_i = _get_mesh_batch_item(mesh, index)
        if vertices_i.shape[0] == 0 or faces_i.shape[0] == 0:
            continue
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        safe_id = str(unique_id or uuid.uuid4().hex).replace("/", "_").replace("\\", "_")
        out_name = f"gjj_triposplat_mesh_{safe_id}_{index + 1:02d}_{uuid.uuid4().hex[:8]}.glb"
        out_path = os.path.join(temp_dir, out_name)
        texture_image = Image.fromarray(texture_np[index], mode="RGB") if texture_np is not None else None
        _save_glb(
            vertices_i,
            faces_i,
            out_path,
            metadata={"source": "GJJ_TripoSplatImageToSplat"},
            uvs=uvs_i,
            vertex_colors=colors_i,
            texture_image=texture_image,
            unlit=bool(getattr(mesh, "unlit", False)),
        )
        return _make_file3d(out_path, "glb")
    raise ValueError("TripoSplat GLB 导出失败：没有有效网格可写入。")


class GJJ_TripoSplatImageToSplat:
    DESCRIPTION = "单图或批量图片生成 TripoSplat 高斯泼溅，并同时输出 SPZ 文件对象和 GLB 网格。模型按去扩展名、去量化标记规则在 models 子目录中搜索。"
    CATEGORY = "GJJ/🧊 三维"
    RETURN_TYPES = ("SPLAT", "FILE_3D_SPLAT_ANY", "MESH", "FILE_3D_GLB")
    RETURN_NAMES = ("SPLAT", "3D泼溅文件", "网格", "GLB网格文件")
    OUTPUT_TOOLTIPS = (
        "内部高斯泼溅对象，可连接 GJJ TripoSplat 渲染节点。",
        "可保存或预览的 SPZ/PLY/KSPLAT 文件对象。",
        "由泼溅提取的彩色网格。",
        "直接导出的 GLB 网格文件，包含顶点色和 unlit 材质，可连接 3D 预览或保存节点。",
    )
    FUNCTION = "generate"
    DISPLAY_NAME = "🧊 TripoSplat一键生成"
    GJJ_HELP = {
        "models": [
            "models/diffusion_models/triposplat_fp16.safetensors",
            "models/clip_vision/dino_v3_vit_h.safetensors",
            "models/vae/triposplat_vae_decoder_fp16.safetensors",
            "models/vae/flux2-vae.safetensors",
            "models/RMBG/rmbg1.4.safetensors",
        ],
        "notice": "默认隐藏高级参数，点击节点上的 ⚙️设置 展开。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("GJJ_BATCH_IMAGE,IMAGE", {"display_name": "输入图片", "tooltip": "支持 GJJ 批量图片或普通 IMAGE。"}),
                "seed": ("INT", _hidden_option({"default": 46, "min": 0, "max": 0xffffffffffffffff, "display_name": "随机种子", "tooltip": "固定后可复现采样和解码。"})),
                "steps": ("INT", _hidden_option({"default": 20, "min": 1, "max": 10000, "display_name": "采样步数", "tooltip": "TripoSplat 采样步数。"})),
                "cfg": ("FLOAT", _hidden_option({"default": 3.0, "min": 0.0, "max": 100.0, "step": 0.1, "display_name": "CFG", "tooltip": "条件引导强度。"})),
                "sampler_name": (["dpmpp_2m"], _hidden_option({"default": "dpmpp_2m", "display_name": "采样器", "tooltip": "默认使用官方工作流采样器。"})),
                "scheduler": (["simple"], _hidden_option({"default": "simple", "display_name": "调度器", "tooltip": "默认使用官方工作流调度器。"})),
                "denoise": ("FLOAT", _hidden_option({"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪强度", "tooltip": "通常保持 1。"})),
                "preprocess_size": ("INT", _hidden_option({"default": 1024, "min": 256, "max": 4096, "step": 16, "display_name": "预处理尺寸", "tooltip": "官方默认 1024。"})),
                "erode_radius": ("INT", _hidden_option({"default": 1, "min": 0, "max": 16, "display_name": "Alpha腐蚀", "tooltip": "避免边缘漏色。"})),
                "num_gaussians": ("INT", _hidden_option({"default": 262144, "min": 32768, "max": 1048576, "step": 32, "display_name": "高斯数量", "tooltip": "最终泼溅密度。"})),
                "splat_format": (["spz", "ply", "ksplat"], _hidden_option({"default": "spz", "display_name": "泼溅格式", "tooltip": "输出 FILE_3D_SPLAT_ANY 的格式。"})),
                "mesh_resolution": ("INT", _hidden_option({"default": 384, "min": 64, "max": 768, "step": 16, "display_name": "网格分辨率", "tooltip": "越高越慢、越占显存。"})),
                "mesh_kernel": ("INT", _hidden_option({"default": 5, "min": 1, "max": 8, "display_name": "网格核大小", "tooltip": "稀疏泼溅可适当调大。"})),
                "mesh_smooth": ("INT", _hidden_option({"default": 0, "min": 0, "max": 60, "display_name": "网格平滑", "tooltip": "Taubin 平滑迭代次数。"})),
                "vram_policy": (["显存优先", "自动"], _hidden_option({"default": "显存优先", "display_name": "显存策略", "tooltip": "显存优先会让 TripoSplat 中间张量尽量留在显卡上；显存不足时可改为自动。"})),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate(
        self,
        image,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        preprocess_size,
        erode_radius,
        num_gaussians,
        splat_format,
        mesh_resolution,
        mesh_kernel,
        mesh_smooth,
        vram_policy="显存优先",
        unique_id=None,
    ):
        start = time.time()
        with _triposplat_vram_policy(vram_policy):
            triposplat, splat_module = _runtime_modules()
            image = _coerce_image_tensor(image)
            send_node_progress(unique_id, f"开始 TripoSplat 一键生成（{vram_policy}）...", 0.03)
            rgba, mask = _remove_background_rmbg14(image, unique_id=unique_id)
            send_node_progress(unique_id, "裁剪并预处理前景...", 0.28)
            prepared = _node_output_value(triposplat.TripoSplatPreprocessImage.execute(image, mask, int(erode_radius), int(preprocess_size)))
            model, clip_vision, vae_flux2, vae_triposplat = _load_models(unique_id=unique_id)
            try:
                send_node_progress(unique_id, "安装采样预览补丁...", 0.30)
                model = _node_output_value(triposplat.TripoSplatSamplingPreview.execute(model, vae_triposplat, 5, 16384, 90.0, 15.0, 2))
            except Exception:
                send_node_progress(unique_id, "采样预览补丁不可用，继续正式采样...", 0.31)
            send_node_progress(unique_id, "编码 TripoSplat 条件...", 0.34)
            positive, negative, latent = triposplat.TripoSplatConditioning.execute(clip_vision, vae_flux2, prepared).args
            send_node_progress(unique_id, "KSampler 正在采样...", 0.42)
            samples = _core_nodes().KSampler().sample(model, int(seed), int(steps), float(cfg), str(sampler_name), str(scheduler), positive, negative, latent, float(denoise))[0]
            send_node_progress(unique_id, "解码高斯泼溅...", 0.72)
            splat = _node_output_value(triposplat.VAEDecodeTripoSplat.execute(samples, vae_triposplat, int(num_gaussians), int(seed)))
            send_node_progress(unique_id, "导出泼溅文件对象...", 0.82)
            file_3d = _node_output_value(splat_module.SplatToFile3D.execute(splat, str(splat_format)))
            send_node_progress(unique_id, "提取网格...", 0.88)
            mesh = _node_output_value(splat_module.SplatToMesh.execute(splat, int(mesh_resolution), int(mesh_kernel), int(mesh_smooth), 0.6, 500, 0.02, 2.0))
            send_node_progress(unique_id, "写入带材质 GLB 网格...", 0.94)
            glb_file = _mesh_to_glb_file3d(mesh, unique_id=unique_id)
            elapsed = time.time() - start
            send_node_progress(unique_id, f"TripoSplat 完成，耗时 {elapsed:.1f} 秒", 1.0)
            return (splat, file_3d, mesh, glb_file)


class GJJ_TripoSplatRenderSequence:
    DESCRIPTION = "为 TripoSplat 创建轨道相机并渲染图片/遮罩序列，可选输入图片作为背景板。"
    CATEGORY = "GJJ/🧊 三维"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图片序列", "遮罩序列")
    OUTPUT_TOOLTIPS = ("渲染出的图片序列。", "渲染出的透明遮罩序列。")
    FUNCTION = "render"
    DISPLAY_NAME = "🎥 TripoSplat渲染序列"
    GJJ_HELP = {"notice": "默认隐藏高级参数，点击节点上的 ⚙️设置 展开。"}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "splat": ("SPLAT", {"display_name": "SPLAT", "tooltip": "TripoSplat 高斯泼溅输入。"}),
                "width": ("INT", _hidden_option({"default": 1024, "min": 64, "max": 2048, "step": 8, "display_name": "宽度", "tooltip": "渲染宽度。"})),
                "height": ("INT", _hidden_option({"default": 1024, "min": 64, "max": 2048, "step": 8, "display_name": "高度", "tooltip": "渲染高度。"})),
                "frames": ("INT", _hidden_option({"default": 75, "min": -240, "max": 240, "display_name": "帧数", "tooltip": "大于 1 时生成轨道环绕序列，负数反向。"})),
                "yaw": ("FLOAT", _hidden_option({"default": 35.0, "min": -360.0, "max": 360.0, "step": 1.0, "display_name": "水平角", "tooltip": "初始轨道相机 yaw。"})),
                "pitch": ("FLOAT", _hidden_option({"default": 30.0, "min": -89.0, "max": 89.0, "step": 1.0, "display_name": "俯仰角", "tooltip": "初始轨道相机 pitch。"})),
                "distance": ("FLOAT", _hidden_option({"default": 2.5, "min": 0.01, "max": 1000.0, "step": 0.01, "display_name": "距离", "tooltip": "相机到目标点距离。"})),
                "fov": ("FLOAT", _hidden_option({"default": 35.0, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "FOV", "tooltip": "垂直视角。"})),
                "splat_scale": ("FLOAT", _hidden_option({"default": 1.0, "min": 0.1, "max": 5.0, "step": 0.05, "display_name": "泼溅缩放", "tooltip": "调节泼溅投影大小。"})),
                "sharpen": ("FLOAT", _hidden_option({"default": 2.0, "min": 1.0, "max": 8.0, "step": 0.5, "display_name": "锐化", "tooltip": "重叠泼溅颜色锐化。"})),
                "opacity_threshold": ("FLOAT", _hidden_option({"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "透明阈值", "tooltip": "剔除低透明度浮点。"})),
                "render_style": (["color", "clay", "depth", "normal"], _hidden_option({"default": "color", "display_name": "渲染样式", "tooltip": "颜色、陶土、深度或法线图。"})),
                "background": ("COLOR", _hidden_option({"default": "#848484", "display_name": "背景色", "tooltip": "未连接背景图时使用。"})),
                "vram_policy": (["显存优先", "自动"], _hidden_option({"default": "显存优先", "display_name": "显存策略", "tooltip": "显存优先会让 TripoSplat 渲染结果尽量保留在显卡上；显存不足时可改为自动。"})),
            },
            "optional": {
                "image": ("GJJ_BATCH_IMAGE,IMAGE", {"display_name": "背景图片", "tooltip": "可选。连接后作为渲染背景板，也用于面板缩略图参考。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def render(self, splat, width, height, frames, yaw, pitch, distance, fov, splat_scale, sharpen, opacity_threshold, render_style, background, vram_policy="显存优先", image=None, unique_id=None):
        start = time.time()
        with _triposplat_vram_policy(vram_policy):
            _, splat_module = _runtime_modules()
            bg_image = _coerce_image_tensor(image) if image is not None else None
            camera_info = _make_camera_info(splat_module, yaw, pitch, distance, fov, unique_id=unique_id)
            send_node_progress(unique_id, f"正在渲染 TripoSplat 序列（{vram_policy}）...", 0.25)
            rendered, mask = splat_module.RenderSplat.execute(
                splat,
                int(width),
                int(height),
                int(frames),
                float(splat_scale),
                float(sharpen),
                0.0,
                float(opacity_threshold),
                str(background),
                str(render_style),
                camera_info=camera_info,
                bg_image=bg_image,
            ).args
            ui = _preview_ui(rendered[: min(8, rendered.shape[0])], "GJJ_TripoSplat_Render")
            elapsed = time.time() - start
            send_node_progress(unique_id, f"渲染完成，耗时 {elapsed:.1f} 秒", 1.0)
            return {"ui": ui, "result": (rendered, mask)}


NODE_CLASS_MAPPINGS = {
    NODE_AIO: GJJ_TripoSplatImageToSplat,
    NODE_RENDER: GJJ_TripoSplatRenderSequence,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_AIO: "GJJ · 🧊 TripoSplat一键生成",
    NODE_RENDER: "GJJ · 🎥 TripoSplat渲染序列",
}
