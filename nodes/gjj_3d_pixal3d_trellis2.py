from __future__ import annotations

"""GJJ Pixal3D / Trellis.2 图生 3D 单节点（零第三方节点依赖）。

所有 3D 管线步骤都直接编排调用 ComfyUI 核心节点（nodes / comfy_extras），
不依赖任何第三方自定义节点。参数由 Python 定义、JS 端全部隐藏，
通过节点面板上的 emoji 按钮排打开浮动窗口按需编辑。
"""

import contextvars
import importlib
import io
import json
import os
from typing import Any

import torch

import folder_paths

from .common_utils.model_manager import gjjutils_resolve_model_by_extensionless_seed
from .common_utils.progress import send_node_progress

NODE_CLASS_NAME = "GJJ_Pixal3DTrellis2ImageToModel"

MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/4b5a36d50e9c"

# 模型选择表（通用，不硬编码绝对路径）：
# (widget 名, folder_paths 目录类型, 官方工作流中的种子文件名, 中文名, 模型树图标)
MODEL_SPECS: tuple[tuple[str, str, tuple[str, ...], str, str], ...] = (
    ("diffusion_model", "diffusion_models",
     ("pixal3d_int8_convrot.safetensors", "trellis_2_int8_convrot.safetensors"),
     "3D 扩散模型（Pixal3D / Trellis.2）", "🟣"),
    ("clip_vision_model", "clip_vision",
     ("dino_v3_L_naf_fp32.safetensors",),
     "DINOv3 视觉模型", "🔵"),
    ("shape_vae_model", "vae",
     ("trellis_2_shape_vae_bf16.safetensors",),
     "结构 VAE（Shape VAE）", "🔴"),
    ("texture_vae_model", "vae",
     ("trellis_2_texture_vae_bf16.safetensors",),
     "纹理 VAE（Texture VAE）", "🔴"),
    ("geometry_model", "geometry_estimation",
     ("moge_2_vitl_normal_fp16.safetensors",),
     "MoGe 相机几何模型", "🟤"),
    ("matting_model", "background_removal",
     ("birefnet.safetensors",),
     "背景移除模型（抠图）", "🟣"),
)

MISSING_MODEL = "[未找到模型]"

PIPELINE_MODES = ("自动", "Pixal3D", "Trellis.2")
SIGN_MODES = ("udf", "sdf")
PLACEMENT_MODES = ("midpoint", "qem")
SEGMENTERS = ("pec", "adaptive")


# --------------------------------------------------------------------------- #
# 通用工具
# --------------------------------------------------------------------------- #
def _hidden_option(options: dict[str, Any] | None = None) -> dict[str, Any]:
    data = dict(options or {})
    data.setdefault("forceInput", False)
    return data


def _sampler_choices() -> list[str]:
    try:
        import comfy.samplers

        return list(comfy.samplers.KSampler.SAMPLERS)
    except Exception:
        return ["euler", "euler_ancestral", "dpmpp_2m", "ddim"]


def _scheduler_choices() -> list[str]:
    try:
        import comfy.samplers

        return list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        return ["normal", "simple", "karras", "beta", "sd_3"]


def _list_model_files(folder_type: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(folder_type))
    except Exception:
        return []


def _pick_default_model(folder_type: str, seeds: tuple[str, ...]) -> str:
    files = _list_model_files(folder_type)
    if not files:
        return MISSING_MODEL
    for seed in seeds:
        hit = gjjutils_resolve_model_by_extensionless_seed(seed, folder_type)
        if hit and hit in files:
            return hit
    return files[0]


def _model_combo(folder_type: str, seeds: tuple[str, ...]) -> tuple[list[str], str]:
    files = _list_model_files(folder_type)
    if not files:
        return [MISSING_MODEL], MISSING_MODEL
    return files, _pick_default_model(folder_type, seeds)


def _ensure_model(folder_type: str, name: str, label_cn: str) -> None:
    if not str(name or "").strip() or name == MISSING_MODEL:
        raise RuntimeError(
            f"缺少{label_cn}。\n"
            f"请把模型放到 ComfyUI/models/{folder_type}/ 目录（支持子目录递归识别）后重试。\n"
            f"模型下载地址：{MODEL_DOWNLOAD_URL}"
        )
    try:
        resolved = folder_paths.get_full_path(folder_type, name)
    except Exception:
        resolved = None
    if not resolved:
        raise RuntimeError(
            f"{label_cn}文件不存在：{name}\n"
            f"请确认模型已放入 ComfyUI/models/{folder_type}/ 目录。\n"
            f"模型下载地址：{MODEL_DOWNLOAD_URL}"
        )


def _get_node_properties(extra_pnginfo: Any, unique_id: Any) -> dict[str, Any]:
    try:
        workflow = (extra_pnginfo or {}).get("workflow") or {}
        for node in workflow.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                return node.get("properties") or {}
    except Exception:
        pass
    return {}


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
        raise ValueError("图片数据无效，请连接 IMAGE / GJJ_BATCH_IMAGE 输入，或点 📂 选择本地参考图片。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError(f"图片张量维度异常：{tuple(image.shape)}")
    return image[..., :3].contiguous()


def _load_uploaded_reference(reference_info: str) -> torch.Tensor | None:
    """读取 JS 端 📂 上传按钮写入的图片记录。"""
    try:
        info = json.loads(str(reference_info or "").strip() or "{}")
    except Exception:
        return None
    filename = str(info.get("filename") or "").strip()
    if not filename:
        return None
    subfolder = str(info.get("subfolder") or "").strip().strip("/")
    image_type = str(info.get("type") or "input").strip()
    rel_path = f"{subfolder}/{filename}" if subfolder else filename
    annotated = f"{rel_path} [{image_type}]" if image_type and image_type != "input" else rel_path
    nodes_mod = importlib.import_module("nodes")
    loaded = nodes_mod.LoadImage().load_image(annotated)
    image = loaded[0] if isinstance(loaded, (tuple, list)) else loaded
    return _coerce_image_tensor(image)


def _resolve_pipeline(mode: str, diffusion_name: str) -> str:
    text = str(mode or "").strip()
    if "Pixal" in text:
        return "pixal3d"
    if "Trellis" in text:
        return "trellis2"
    key = str(diffusion_name or "").replace("\\", "/").split("/")[-1].lower()
    if "pixal" in key:
        return "pixal3d"
    if "trellis" in key:
        return "trellis2"
    raise RuntimeError(
        "无法识别 3D 管线分支。\n请在「✂️ 预处理」面板手动选择 Pixal3D 或 Trellis.2，"
        "或更换文件名包含 pixal / trellis 关键字的扩散模型。"
    )


# --------------------------------------------------------------------------- #
# 核心节点懒加载与统一调用
# --------------------------------------------------------------------------- #
def _core_node_class(node_id: str):
    nodes_mod = importlib.import_module("nodes")
    cls = getattr(nodes_mod, "NODE_CLASS_MAPPINGS", {}).get(node_id)
    if cls is None:
        raise RuntimeError(
            f"当前 ComfyUI 缺少核心节点「{node_id}」，无法执行 Pixal3D/Trellis.2 管线。"
            "请升级到较新的 ComfyUI 官方版本后重试。"
        )
    return cls


# 当前 GJJ 节点的 hidden 上下文（UNIQUE_ID / PROMPT / EXTRA_PNGINFO）。
# 新版 IO.ComfyNode（如 RemeshMesh / DecimateMesh / UnwrapMesh）执行时会
# 读取 cls.hidden.unique_id 向前端推送进度，必须像官方执行器一样先注入。
_P3D_HIDDEN_INPUTS: contextvars.ContextVar[dict[str, Any] | None] = (
    contextvars.ContextVar("gjj_p3d_hidden_inputs", default=None))


def _run_core(node_id: str, *args: Any, **kwargs: Any) -> list[Any]:
    """执行核心节点并返回输出列表，兼容新旧两套节点 API。

    旧版节点：直接调用 FUNCTION；新版 IO.ComfyNode：按官方执行器方式
    PREPARE_CLASS_CLONE(v3_data) 注入 hidden 后再走 EXECUTE_NORMALIZED，
    这样节点内部 cls.hidden.unique_id 等上下文才可用。
    """
    cls = _core_node_class(node_id)
    try:
        if hasattr(cls, "PREPARE_CLASS_CLONE") and hasattr(cls, "EXECUTE_NORMALIZED"):
            # 新版 IO.ComfyNode（comfy_api.latest.IO.ComfyNode）
            hidden_inputs = _P3D_HIDDEN_INPUTS.get() or {}
            v3_data = {"hidden_inputs": hidden_inputs}
            class_clone = cls.PREPARE_CLASS_CLONE(v3_data)
            out = class_clone.EXECUTE_NORMALIZED(*args, **kwargs)
        else:
            # 旧版节点：实例化后按 FUNCTION 指定的方法调用（与官方执行器一致）
            instance = cls()
            func_name = getattr(cls, "FUNCTION", None)
            runner = getattr(instance, "execute", None) or (
                getattr(instance, func_name, None) if func_name else None)
            if runner is None:
                raise RuntimeError(
                    f"核心节点「{node_id}」找不到可调用的执行方法。")
            out = runner(*args, **kwargs)
    except Exception as exc:
        raise RuntimeError(f"核心节点「{node_id}」执行失败：{exc}") from exc
    values = getattr(out, "args", None)
    if not values:
        values = getattr(out, "result", None)
    if isinstance(values, tuple):
        return list(values)
    if values is None and isinstance(out, tuple):
        return list(out)
    if not values:
        raise RuntimeError(f"核心节点「{node_id}」没有返回输出。")
    return list(values)


def _sample(model: Any, latent: Any, positive: Any, negative: Any,
            seed: int, steps: int, cfg: float, sampler: str, scheduler: str) -> Any:
    nodes_mod = importlib.import_module("nodes")
    result = nodes_mod.KSampler().sample(
        model, int(seed), int(steps), float(cfg),
        str(sampler), str(scheduler), positive, negative, latent, 1.0,
    )
    return result[0]


def _patch_chain(model: Any, cfg_value: float, cfg_start: float,
                 rescale: float, shift: float | None = None) -> Any:
    """CFGOverride -> RescaleCFG -> (可选) ModelSamplingSD3。"""
    model = _run_core("CFGOverride", model, float(cfg_value), float(cfg_start), 1.0)[0]
    advanced = importlib.import_module("comfy_extras.nodes_model_advanced")
    model = advanced.RescaleCFG().patch(model, float(rescale))[0]
    if shift is not None:
        model = advanced.ModelSamplingSD3().patch(model, float(shift))[0]
    return model


def _make_file3d(source: Any, file_format: str = "glb"):
    try:
        latest = importlib.import_module("comfy_api.latest")
        file3d_cls = getattr(getattr(latest, "Types", None), "File3D", None)
    except Exception:
        file3d_cls = None
    if file3d_cls is None:
        raise RuntimeError("当前 ComfyUI 缺少 File3D 类型，无法导出 GLB，请升级 ComfyUI。")
    return file3d_cls(source, file_format=file_format)


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #
class GJJ_Pixal3DTrellis2ImageToModel:
    """Pixal3D / Trellis.2 图生 3D 全管线零依赖单节点。"""

    CATEGORY = "GJJ/🧊 三维工具"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    RETURN_TYPES = ("MESH", "FILE_3D_GLB", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = (
        "🧊 最终网格",
        "📦 GLB模型文件",
        "🎨 基础颜色贴图",
        "⚙️ 金属度贴图",
        "🧫 粗糙度贴图",
        "🧭 法线贴图",
        "🌑 环境光遮蔽贴图",
    )
    RETURN_TOOLTIPS = (
        "完成重拓扑、UV、烘焙并贴好全套 PBR 贴图的最终网格。",
        "可直接保存或预览的 GLB 二进制 3D 文件。",
        "从体素颜色烘焙出的基础颜色（Base Color）贴图。",
        "金属度（Metallic）贴图。",
        "粗糙度（Roughness）贴图。",
        "从高模烘焙到低模的切线空间法线贴图。",
        "环境光遮蔽（Ambient Occlusion）贴图。",
    )

    GJJ_HELP = {
        "title": "🧊 Pixal3D/Trellis.2 图生3D",
        "description": "一张图直接生成带 PBR 贴图的 3D 模型（GLB），内置 Pixal3D 与 Trellis.2 两条管线，"
                       "零第三方节点依赖，全部由 ComfyUI 核心节点编排。",
        "notice": "1) 通过 📂 选择本地参考图，或向图片接口连接 IMAGE；连接外部图片时 📂 自动灰显。\n"
                  "2) 模型在 🧠 面板以模型树选择；源模型缺失时自动按组名匹配，过滤为 0 时红显官方默认模型。\n"
                  "3) Pixal3D 默认 pad_factor=1.1；Trellis.2 建议 pad_factor=1.0（切换分支时自动设置）。\n"
                  "4) 默认只输出「🧊 最终网格」；GLB 文件与五张 PBR 贴图在 🔌 面板按需启用，设置随工作流保存。\n"
                  "5) 全管线较重，建议显存 ≥ 12GB；结构 512 → 形状精修 → 1536 升采样 → 纹理 12 步。",
        "models": [
            "models/diffusion_models/pixal3d_int8_convrot.safetensors",
            "models/diffusion_models/trellis_2_int8_convrot.safetensors",
            "models/clip_vision/dino_v3_L_naf_fp32.safetensors",
            "models/geometry_estimation/moge_2_vitl_normal_fp16.safetensors",
            "models/vae/trellis_2_shape_vae_bf16.safetensors",
            "models/vae/trellis_2_texture_vae_bf16.safetensors",
            "models/background_removal/birefnet.safetensors",
        ],
        "dependencies": [],
        "optional_dependencies": [],
        "model_tree": True,
        "model_download_url": MODEL_DOWNLOAD_URL,
    }

    # --------------------------------------------------------------- schema
    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        samplers = _sampler_choices()
        schedulers = _scheduler_choices()

        required: dict[str, tuple] = {}

        # —— 模型（🧠 模型树面板） ——
        for widget_name, folder_type, seeds, label, _icon in MODEL_SPECS:
            choices, default = _model_combo(folder_type, seeds)
            required[widget_name] = (
                choices,
                _hidden_option({
                    "default": default,
                    "display_name": label,
                    "tooltip": f"自动搜索 ComfyUI/models/{folder_type}/ 及其子目录。"
                               f"缺失时在 🧠 面板会红显官方默认模型。",
                }),
            )

        # —— 预处理 / 相机（✂️ 面板；布尔开关由 node.properties 提供） ——
        required["pipeline_mode"] = (
            PIPELINE_MODES,
            _hidden_option({"default": "自动", "display_name": "3D 管线分支",
                            "tooltip": "自动 = 按扩散模型文件名识别；也可手动强制 Pixal3D / Trellis.2。"}),
        )
        required["crop_size"] = (
            "INT", _hidden_option({"default": 1024, "min": 256, "max": 4096, "step": 8,
                                   "display_name": "裁剪输出尺寸", "tooltip": "按遮罩裁剪后缩放到的正方形边长。"}))
        required["pad_factor"] = (
            "FLOAT", _hidden_option({"default": 1.1, "min": 1.0, "max": 2.0, "step": 0.01,
                                     "display_name": "主体留白倍数", "tooltip": "Pixal3D 推荐 1.1，Trellis.2 推荐 1.0。"}))
        required["grow_mask"] = (
            "INT", _hidden_option({"default": 0, "min": -32, "max": 32, "step": 1,
                                   "display_name": "遮罩扩张像素", "tooltip": "裁剪前扩张（正值）或收缩（负值）遮罩。"}))
        required["background"] = (
            "STRING", _hidden_option({"default": "#000000", "display_name": "裁剪背景色",
                                      "tooltip": "抠图后主体背后的填充颜色。"}))
        required["fallback_fov"] = (
            "FLOAT", _hidden_option({"default": 49.13, "min": 1.0, "max": 179.0, "step": 0.01,
                                     "display_name": "备用水平FOV", "tooltip": "未启用 MoGe 相机估计时，Pixal3D 使用的水平视场角（度）。"}))
        required["geometry_level"] = (
            "INT", _hidden_option({"default": 9, "min": 1, "max": 9, "step": 1,
                                   "display_name": "MoGe 推理分辨率等级", "tooltip": "越高越精细越慢，官方管线使用 9。"}))
        required["geometry_batch"] = (
            "INT", _hidden_option({"default": 4, "min": 1, "max": 32, "step": 1,
                                   "display_name": "MoGe 批大小", "tooltip": "视显存调整。"}))

        # —— 结构 512 / 形状精修 / 高分辨率形状（🔺 面板） ——
        required["structure_seed"] = ("INT", _hidden_option({"default": 56, "min": 0, "max": 2**31 - 1,
                                                             "display_name": "结构阶段随机种子"}))
        required["structure_steps"] = ("INT", _hidden_option({"default": 12, "min": 1, "max": 100,
                                                              "display_name": "结构采样步数"}))
        required["structure_cfg"] = ("FLOAT", _hidden_option({"default": 7.5, "min": 0.0, "max": 30.0, "step": 0.1,
                                                              "display_name": "结构 CFG"}))
        required["structure_sampler"] = (samplers, _hidden_option({"default": "euler", "display_name": "结构采样器"}))
        required["structure_scheduler"] = (schedulers, _hidden_option({"default": "normal", "display_name": "结构调度器"}))
        required["sd3_shift"] = ("FLOAT", _hidden_option({"default": 5.0, "min": 0.0, "max": 20.0, "step": 0.1,
                                                          "display_name": "SD3 采样位移", "tooltip": "ModelSamplingSD3 的 shift。"}))
        required["structure_cfg_start"] = ("FLOAT", _hidden_option({
            "default": 0.667, "min": 0.0, "max": 1.0, "step": 0.001,
            "display_name": "结构CFG覆盖起点", "tooltip": "采样后段把 CFG 覆盖为 1 的起始进度。"}))
        required["structure_rescale"] = ("FLOAT", _hidden_option({"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.01,
                                                                  "display_name": "结构 RescaleCFG 系数"}))
        required["structure_resolution"] = (
            ("32", "64"), _hidden_option({"default": "32", "display_name": "结构体素分辨率",
                                         "tooltip": "结构 VAE 解码档位，32 为官方默认。"}))
        required["refine_seed"] = ("INT", _hidden_option({"default": 42, "min": 0, "max": 2**31 - 1,
                                                          "display_name": "形状精修种子"}))
        required["refine_steps"] = ("INT", _hidden_option({"default": 20, "min": 1, "max": 100,
                                                           "display_name": "形状精修步数"}))
        required["refine_cfg"] = ("FLOAT", _hidden_option({"default": 7.5, "min": 0.0, "max": 30.0, "step": 0.1,
                                                           "display_name": "形状精修 CFG"}))
        required["refine_sampler"] = (samplers, _hidden_option({"default": "euler", "display_name": "形状精修采样器"}))
        required["refine_scheduler"] = (schedulers, _hidden_option({"default": "normal", "display_name": "形状精修调度器"}))
        required["refine_cfg_start"] = ("FLOAT", _hidden_option({"default": 0.769, "min": 0.0, "max": 1.0, "step": 0.001,
                                                                 "display_name": "精修CFG覆盖起点"}))
        required["refine_rescale"] = ("FLOAT", _hidden_option({"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01,
                                                               "display_name": "精 RescaleCFG 系数"}))
        required["upsample_resolution"] = ("INT", _hidden_option({"default": 1536, "min": 256, "max": 4096, "step": 64,
                                                                  "display_name": "级联升采样目标分辨率"}))
        required["hr_seed"] = ("INT", _hidden_option({"default": 42, "min": 0, "max": 2**31 - 1,
                                                      "display_name": "高分辨率形状种子"}))
        required["hr_steps"] = ("INT", _hidden_option({"default": 12, "min": 1, "max": 100,
                                                       "display_name": "高分辨率形状步数"}))
        required["hr_cfg"] = ("FLOAT", _hidden_option({"default": 7.5, "min": 0.0, "max": 30.0, "step": 0.1,
                                                       "display_name": "高分辨率形状 CFG"}))
        required["hr_sampler"] = (samplers, _hidden_option({"default": "euler", "display_name": "高分辨率形状采样器"}))
        required["hr_scheduler"] = (schedulers, _hidden_option({"default": "simple", "display_name": "高分辨率形状调度器"}))

        # —— 网格重拓扑（🧱 面板；fix_poles 走 properties） ——
        required["remesh_resolution"] = ("INT", _hidden_option({"default": 768, "min": 32, "max": 4096, "step": 16,
                                                                "display_name": "重网格密度"}))
        required["sign_mode"] = (SIGN_MODES, _hidden_option({"default": "udf", "display_name": "符号场模式",
                                                             "tooltip": "udf：无符号距离场；sdf：有符号。"}))
        required["remesh_band"] = ("FLOAT", _hidden_option({"default": 1.0, "min": 0.1, "max": 8.0, "step": 0.1,
                                                            "display_name": "重网格带宽"}))
        required["project_back"] = ("FLOAT", _hidden_option({"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                                             "display_name": "投影回原表面距离"}))
        required["smooth_iters"] = ("INT", _hidden_option({"default": 20, "min": 0, "max": 200, "step": 1,
                                                           "display_name": "平滑迭代次数"}))
        required["drop_small_components"] = ("FLOAT", _hidden_option({
            "default": 0.01, "min": 0.0, "max": 1.0, "step": 0.001,
            "display_name": "丢弃小部件比例"}))
        required["precluster_max_verts"] = ("INT", _hidden_option({"default": 20000000, "min": 1000, "max": 100000000,
                                                                   "step": 1000, "display_name": "预聚类顶点上限"}))
        required["decimate_faces"] = ("INT", _hidden_option({"default": 700000, "min": 100, "max": 20000000, "step": 1000,
                                                             "display_name": "抽稀目标面数"}))
        required["placement_mode"] = (PLACEMENT_MODES, _hidden_option({"default": "midpoint",
                                                                       "display_name": "抽稀边折叠策略"}))
        required["mesh_crease"] = ("FLOAT", _hidden_option({"default": 180.0, "min": 0.0, "max": 180.0, "step": 1.0,
                                                            "display_name": "平滑法线折角（展开前）"}))

        # —— 纹理 / 烘焙（🎨 面板；ignore_backfaces 走 properties） ——
        required["texture_seed"] = ("INT", _hidden_option({"default": 43, "min": 0, "max": 2**31 - 1,
                                                           "display_name": "纹理阶段种子"}))
        required["texture_steps"] = ("INT", _hidden_option({"default": 12, "min": 1, "max": 100,
                                                            "display_name": "纹理采样步数"}))
        required["texture_cfg"] = ("FLOAT", _hidden_option({"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1,
                                                            "display_name": "纹理 CFG"}))
        required["texture_sampler"] = (samplers, _hidden_option({"default": "euler", "display_name": "纹理采样器"}))
        required["texture_scheduler"] = (schedulers, _hidden_option({"default": "normal", "display_name": "纹理调度器"}))
        required["unwrap_segmenter"] = (SEGMENTERS, _hidden_option({"default": "pec", "display_name": "UV 分割算法"}))
        required["unwrap_resolution"] = ("INT", _hidden_option({"default": 4096, "min": 256, "max": 8192, "step": 256,
                                                                "display_name": "UV 展开分辨率"}))
        required["unwrap_padding"] = ("INT", _hidden_option({"default": 1, "min": 0, "max": 32, "step": 1,
                                                             "display_name": "UV 岛间距"}))
        required["weld_distance"] = ("FLOAT", _hidden_option({"default": 0.0002, "min": 0.0, "max": 0.1, "step": 0.0001,
                                                              "display_name": "焊接距离"}))
        required["texture_size"] = ("INT", _hidden_option({"default": 4096, "min": 256, "max": 8192, "step": 256,
                                                           "display_name": "颜色贴图烘焙尺寸"}))
        required["normal_resolution"] = ("INT", _hidden_option({"default": 2048, "min": 256, "max": 8192, "step": 256,
                                                                "display_name": "法线贴图烘焙尺寸"}))
        required["cage_distance"] = ("FLOAT", _hidden_option({"default": 0.05, "min": 0.0, "max": 1.0, "step": 0.01,
                                                              "display_name": "法线烘焙笼距离"}))
        required["ao_resolution"] = ("INT", _hidden_option({"default": 1024, "min": 256, "max": 8192, "step": 256,
                                                            "display_name": "AO 烘焙尺寸"}))
        required["ao_samples"] = ("INT", _hidden_option({"default": 64, "min": 1, "max": 512, "step": 1,
                                                         "display_name": "AO 采样数"}))
        required["ao_max_distance"] = ("FLOAT", _hidden_option({"default": 0.71, "min": 0.0, "max": 10.0, "step": 0.01,
                                                                "display_name": "AO 最大距离"}))
        required["ao_strength"] = ("FLOAT", _hidden_option({"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                                            "display_name": "AO 强度"}))
        required["ao_bias"] = ("FLOAT", _hidden_option({"default": 0.01, "min": 0.0, "max": 1.0, "step": 0.001,
                                                        "display_name": "AO 偏移"}))
        required["final_crease"] = ("FLOAT", _hidden_option({"default": 180.0, "min": 0.0, "max": 180.0, "step": 1.0,
                                                             "display_name": "最终平滑法线折角"}))

        # —— 导出（🎨 面板；save_to_output 走 properties） ——
        required["filename_prefix"] = ("STRING", _hidden_option({"default": "3d/ComfyUI",
                                                                 "display_name": "保存文件名前缀"}))
        # 📂 上传参考图的记录（JS 写入，用户不可见）
        required["reference_info"] = ("STRING", _hidden_option({"default": "",
                                                                "display_name": "参考图记录"}))

        return {
            "required": required,
            "optional": {
                "image": ("GJJ_BATCH_IMAGE,IMAGE", {
                    "tooltip": "参考图片输入。未连接时可点面板 📂 选择本地图片；连接外部图片后 📂 自动灰显禁用。",
                    "forceInput": True,
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    # ------------------------------------------------------------ execute
    def generate(
        self,
        image: Any = None,
        *,
        diffusion_model: str,
        clip_vision_model: str,
        shape_vae_model: str,
        texture_vae_model: str,
        geometry_model: str,
        matting_model: str,
        pipeline_mode: str = "自动",
        crop_size: int = 1024,
        pad_factor: float = 1.1,
        grow_mask: int = 0,
        background: str = "#000000",
        fallback_fov: float = 49.13,
        geometry_level: int = 9,
        geometry_batch: int = 4,
        structure_seed: int = 56,
        structure_steps: int = 12,
        structure_cfg: float = 7.5,
        structure_sampler: str = "euler",
        structure_scheduler: str = "normal",
        sd3_shift: float = 5.0,
        structure_cfg_start: float = 0.667,
        structure_rescale: float = 0.7,
        structure_resolution: str = "32",
        refine_seed: int = 42,
        refine_steps: int = 20,
        refine_cfg: float = 7.5,
        refine_sampler: str = "euler",
        refine_scheduler: str = "normal",
        refine_cfg_start: float = 0.769,
        refine_rescale: float = 0.5,
        upsample_resolution: int = 1536,
        hr_seed: int = 42,
        hr_steps: int = 12,
        hr_cfg: float = 7.5,
        hr_sampler: str = "euler",
        hr_scheduler: str = "simple",
        remesh_resolution: int = 768,
        sign_mode: str = "udf",
        remesh_band: float = 1.0,
        project_back: float = 0.0,
        smooth_iters: int = 20,
        drop_small_components: float = 0.01,
        precluster_max_verts: int = 20000000,
        decimate_faces: int = 700000,
        placement_mode: str = "midpoint",
        mesh_crease: float = 180.0,
        texture_seed: int = 43,
        texture_steps: int = 12,
        texture_cfg: float = 1.0,
        texture_sampler: str = "euler",
        texture_scheduler: str = "normal",
        unwrap_segmenter: str = "pec",
        unwrap_resolution: int = 4096,
        unwrap_padding: int = 1,
        weld_distance: float = 0.0002,
        texture_size: int = 4096,
        normal_resolution: int = 2048,
        cage_distance: float = 0.05,
        ao_resolution: int = 1024,
        ao_samples: int = 64,
        ao_max_distance: float = 0.71,
        ao_strength: float = 1.0,
        ao_bias: float = 0.01,
        final_crease: float = 180.0,
        filename_prefix: str = "3d/ComfyUI",
        reference_info: str = "",
        unique_id: Any = None,
        prompt: Any = None,
        extra_pnginfo: Any = None,
        **_kwargs: Any,
    ):
        props = _get_node_properties(extra_pnginfo, unique_id)
        enable_matting = bool(props.get("enable_matting", True))
        enable_geometry = bool(props.get("enable_geometry", True))
        geometry_force = bool(props.get("geometry_force_projection", True))
        geometry_mask = bool(props.get("geometry_apply_mask", True))
        fix_poles = bool(props.get("remesh_fix_poles", False))
        ignore_backfaces = bool(props.get("normal_ignore_backfaces", True))
        save_to_output = bool(props.get("save_to_output", True))

        def progress(text: str, ratio: float | None = None) -> None:
            send_node_progress(unique_id, text, ratio)

        # 注入 hidden 上下文，供新版 IO.ComfyNode 核心节点读取（如 RemeshMesh 进度推送）
        hidden_token = _P3D_HIDDEN_INPUTS.set({
            "UNIQUE_ID": unique_id,
            "PROMPT": prompt,
            "EXTRA_PNGINFO": extra_pnginfo,
            "DYNPROMPT": None,
        })
        try:
            return self._run_pipeline(
                progress=progress,
                image=image,
                reference_info=reference_info,
                pipeline_mode=pipeline_mode,
                diffusion_model=diffusion_model,
                clip_vision_model=clip_vision_model,
                shape_vae_model=shape_vae_model,
                texture_vae_model=texture_vae_model,
                geometry_model=geometry_model,
                matting_model=matting_model,
                enable_matting=enable_matting,
                crop_size=crop_size,
                pad_factor=pad_factor,
                grow_mask=grow_mask,
                background=background,
                enable_geometry=enable_geometry,
                fallback_fov=fallback_fov,
                geometry_level=geometry_level,
                geometry_batch=geometry_batch,
                geometry_force=geometry_force,
                geometry_mask=geometry_mask,
                structure_seed=structure_seed,
                structure_steps=structure_steps,
                structure_cfg=structure_cfg,
                structure_sampler=structure_sampler,
                structure_scheduler=structure_scheduler,
                sd3_shift=sd3_shift,
                structure_cfg_start=structure_cfg_start,
                structure_rescale=structure_rescale,
                structure_resolution=structure_resolution,
                refine_seed=refine_seed,
                refine_steps=refine_steps,
                refine_cfg=refine_cfg,
                refine_sampler=refine_sampler,
                refine_scheduler=refine_scheduler,
                refine_cfg_start=refine_cfg_start,
                refine_rescale=refine_rescale,
                upsample_resolution=upsample_resolution,
                hr_seed=hr_seed,
                hr_steps=hr_steps,
                hr_cfg=hr_cfg,
                hr_sampler=hr_sampler,
                hr_scheduler=hr_scheduler,
                remesh_resolution=remesh_resolution,
                sign_mode=sign_mode,
                remesh_band=remesh_band,
                project_back=project_back,
                fix_poles=fix_poles,
                smooth_iters=smooth_iters,
                drop_small_components=drop_small_components,
                precluster_max_verts=precluster_max_verts,
                decimate_faces=decimate_faces,
                placement_mode=placement_mode,
                mesh_crease=mesh_crease,
                texture_seed=texture_seed,
                texture_steps=texture_steps,
                texture_cfg=texture_cfg,
                texture_sampler=texture_sampler,
                texture_scheduler=texture_scheduler,
                unwrap_segmenter=unwrap_segmenter,
                unwrap_resolution=unwrap_resolution,
                unwrap_padding=unwrap_padding,
                weld_distance=weld_distance,
                texture_size=texture_size,
                normal_resolution=normal_resolution,
                cage_distance=cage_distance,
                ignore_backfaces=ignore_backfaces,
                ao_resolution=ao_resolution,
                ao_samples=ao_samples,
                ao_max_distance=ao_max_distance,
                ao_strength=ao_strength,
                ao_bias=ao_bias,
                final_crease=final_crease,
                filename_prefix=filename_prefix,
                save_to_output=save_to_output,
            )
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Pixal3D/Trellis.2 图生3D 执行失败：{exc}") from exc
        finally:
            _P3D_HIDDEN_INPUTS.reset(hidden_token)

    # --------------------------------------------------------- pipeline
    def _run_pipeline(self, *, progress, **p: Any):
        nodes_mod = importlib.import_module("nodes")

        branch = _resolve_pipeline(p["pipeline_mode"], p["diffusion_model"])
        progress(f"🧊 管线分支：{'Pixal3D' if branch == 'pixal3d' else 'Trellis.2'}，开始校验模型…", 0.01)

        # 1) 模型校验 ----------------------------------------------------- #
        for widget_name, folder_type, _seeds, label, _icon in MODEL_SPECS:
            if widget_name == "geometry_model":
                continue  # MoGe 仅 Pixal3D 相机估计分支需要，下面单独校验
            _ensure_model(folder_type, p[widget_name], label)
        if branch == "pixal3d" and p["enable_geometry"]:
            _ensure_model("geometry_estimation", p["geometry_model"], "MoGe 相机几何模型")

        # 2) 参考图 ------------------------------------------------------- #
        progress("🖼️ 读取参考图片…", 0.03)
        image = None
        if p["image"] is not None:
            image = _coerce_image_tensor(p["image"])
        else:
            image = _load_uploaded_reference(p["reference_info"])
        if image is None:
            raise RuntimeError("没有参考图片：请点节点面板的 📂 选择本地图片，或向图片接口连接 IMAGE 输出。")
        batch_size = int(image.shape[0])

        # 3) 抠图 + 裁剪 -------------------------------------------------- #
        if p["enable_matting"]:
            progress("✂️ 官方背景移除（抠图）…", 0.05)
            bg_model = _run_core("LoadBackgroundRemovalModel", p["matting_model"])[0]
            mask = _run_core("RemoveBackground", bg_model, image)[0]
        else:
            progress("✂️ 跳过抠图，使用全白遮罩…", 0.05)
            mask = torch.ones((batch_size, int(image.shape[1]), int(image.shape[2])),
                              dtype=torch.float32, device=image.device)
        progress("📐 按遮罩居中裁剪到方形…", 0.08)
        cropped = _run_core(
            "ImageCropToMask", image, mask,
            int(p["crop_size"]), int(p["crop_size"]),
            float(p["pad_factor"]), int(p["grow_mask"]), str(p["background"]),
        )[0]

        # 4) 相机 FOV（仅 Pixal3D 需要） ---------------------------------- #
        fov_x = float(p["fallback_fov"])
        if branch == "pixal3d":
            if p["enable_geometry"]:
                progress("📷 MoGe 估计相机内参 / FOV…", 0.11)
                moge = _run_core("LoadMoGeModel", p["geometry_model"])[0]
                geometry = _run_core(
                    "MoGeInference", moge, cropped,
                    int(p["geometry_level"]), 0.0, int(p["geometry_batch"]),
                    bool(p["geometry_force"]), bool(p["geometry_mask"]),
                )[0]
                fov_x = float(_run_core("MoGeGeometryToFOV", geometry, "horizontal", "degrees")[0])
                progress(f"📷 MoGe 水平 FOV = {fov_x:.2f}°", 0.14)
            else:
                progress(f"📷 使用备用水平 FOV = {fov_x:.2f}°", 0.14)

        # 5) 视觉条件 ----------------------------------------------------- #
        progress("🧠 加载 DINOv3 视觉模型…", 0.15)
        clip_vision = nodes_mod.CLIPVisionLoader().load_clip(p["clip_vision_model"])[0]
        if branch == "pixal3d":
            positive, negative = _run_core("Pixal3DConditioning", clip_vision, cropped, fov_x)
        else:
            positive, negative = _run_core("Trellis2Conditioning", clip_vision, cropped)

        # 6) 扩散模型 ----------------------------------------------------- #
        progress("🟣 加载 3D 扩散模型…", 0.18)
        model = nodes_mod.UNETLoader().load_unet(p["diffusion_model"], "default")[0]
        structure_model = _patch_chain(
            model, 1.0, p["structure_cfg_start"], p["structure_rescale"], p["sd3_shift"])
        refine_model = _patch_chain(
            model, 1.0, p["refine_cfg_start"], p["refine_rescale"], None)

        # 7) 结构 512 ----------------------------------------------------- #
        progress("🔺 结构潜空间初始化…", 0.2)
        latent = _run_core("EmptyTrellis2LatentStructure", batch_size)[0]
        progress(f"🔺 结构采样（{int(p['structure_steps'])} 步）…", 0.22)
        samples = _sample(model=structure_model, latent=latent, positive=positive, negative=negative,
                          seed=p["structure_seed"], steps=p["structure_steps"], cfg=p["structure_cfg"],
                          sampler=p["structure_sampler"], scheduler=p["structure_scheduler"])
        progress("🧊 解码结构体素…", 0.3)
        voxel = _run_core("VaeDecodeStructureTrellis2", samples,
                          _load_vae(p["shape_vae_model"]), str(p["structure_resolution"]))[0]

        # 8) 形状精修（512 网格） ----------------------------------------- #
        progress("🔺 形状阶段编码…", 0.34)
        positive_s, negative_s, latent_s = _run_core("Trellis2ShapeStage", positive, negative, voxel)
        progress(f"🔺 形状精修采样（{int(p['refine_steps'])} 步）…", 0.37)
        samples_s = _sample(model=refine_model, latent=latent_s, positive=positive_s, negative=negative_s,
                            seed=p["refine_seed"], steps=p["refine_steps"], cfg=p["refine_cfg"],
                            sampler=p["refine_sampler"], scheduler=p["refine_scheduler"])

        # 9) 级联升采样 → 高分辨率形状 ------------------------------------ #
        progress(f"⬆️ 级联升采样到 {int(p['upsample_resolution'])}…", 0.45)
        shape_vae = _load_vae(p["shape_vae_model"])
        positive_h, negative_h, latent_h = _run_core(
            "Trellis2UpsampleStage", positive_s, negative_s, samples_s, shape_vae,
            int(p["upsample_resolution"]))
        progress(f"🔺 高分辨率形状采样（{int(p['hr_steps'])} 步）…", 0.5)
        samples_h = _sample(model=refine_model, latent=latent_h, positive=positive_h, negative=negative_h,
                            seed=p["hr_seed"], steps=p["hr_steps"], cfg=p["hr_cfg"],
                            sampler=p["hr_sampler"], scheduler=p["hr_scheduler"])
        progress("🧊 解码高分辨率网格（高模）…", 0.6)
        high_mesh, shape_subdivides = _run_core("VaeDecodeShapeTrellis", samples_h, shape_vae)

        # 10) 重拓扑 / 抽稀 / 平滑 / UV ----------------------------------- #
        progress("🧱 重网格（Remesh）…", 0.66)
        remeshed = _run_core(
            "RemeshMesh", high_mesh, int(p["remesh_resolution"]),
            {
                "sign_mode": str(p["sign_mode"]),
                "qef": False,
                "drop_inverted_components": False,
                "drop_enclosed_components": False,
            },
            float(p["remesh_band"]), float(p["project_back"]), bool(p["fix_poles"]),
            int(p["smooth_iters"]), float(p["drop_small_components"]), int(p["precluster_max_verts"]),
        )[0]
        progress("🧱 抽稀减面（Decimate）…", 0.7)
        decimated = _run_core("DecimateMesh", remeshed, int(p["decimate_faces"]),
                              {"placement_mode": str(p["placement_mode"])})[0]
        progress("🧱 平滑法线…", 0.72)
        smoothed = _run_core("MeshSmoothNormals", decimated, float(p["mesh_crease"]))[0]
        progress("🧱 UV 展开（Unwrap）…", 0.74)
        unwrapped = _run_core(
            "UnwrapMesh", smoothed, str(p["unwrap_segmenter"]),
            int(p["unwrap_resolution"]), int(p["unwrap_padding"]), float(p["weld_distance"]),
        )[0]

        # 11) 纹理采样 → 体素颜色 ----------------------------------------- #
        progress("🎨 纹理阶段编码…", 0.78)
        positive_t, negative_t, latent_t = _run_core(
            "Trellis2TextureStage", positive_h, negative_h, samples_h)
        progress(f"🎨 纹理采样（{int(p['texture_steps'])} 步，CFG={float(p['texture_cfg']):g}）…", 0.8)
        samples_t = _sample(model=model, latent=latent_t, positive=positive_t, negative=negative_t,
                            seed=p["texture_seed"], steps=p["texture_steps"], cfg=p["texture_cfg"],
                            sampler=p["texture_sampler"], scheduler=p["texture_scheduler"])
        progress("🎨 解码纹理体素颜色…", 0.85)
        texture_vae = _load_vae(p["texture_vae_model"])
        voxel_colors = _run_core("VaeDecodeTextureTrellis", samples_t, texture_vae, shape_subdivides)[0]

        # 12) 烘焙贴图 ---------------------------------------------------- #
        progress("🎨 烘焙基础颜色 / 金属 / 粗糙…", 0.88)
        base_color, metallic, roughness = _run_core(
            "BakeTextureFromVoxel", unwrapped, voxel_colors,
            int(p["texture_size"]), reference_mesh=high_mesh)
        progress("🧭 烘焙法线贴图…", 0.91)
        normal = _run_core("BakeNormalMapFromMesh", unwrapped, remeshed,
                           int(p["normal_resolution"]), float(p["cage_distance"]),
                           bool(p["ignore_backfaces"]))[0]
        progress("🌑 烘焙环境光遮蔽…", 0.94)
        occlusion = _run_core(
            "BakeAmbientOcclusion", unwrapped, remeshed,
            int(p["ao_resolution"]), int(p["ao_samples"]), float(p["ao_max_distance"]),
            float(p["ao_strength"]), float(p["ao_bias"]),
        )[0]

        # 13) 合成材质 + 导出 --------------------------------------------- #
        progress("🎨 应用 PBR 材质到网格…", 0.97)
        textured = _run_core("ApplyTextureToMesh", unwrapped, base_color,
                             metallic, roughness, occlusion, normal)[0]
        final_mesh = _run_core("MeshSmoothNormals", textured, float(p["final_crease"]))[0]

        progress("📦 导出 GLB…", 0.99)
        ui: dict[str, Any] = {}
        file3d = self._export_glb(final_mesh, str(p["filename_prefix"]), bool(p["save_to_output"]), ui)

        progress("✅ 3D 模型生成完成", 1.0)
        return {
            "ui": ui,
            "result": (final_mesh, file3d, base_color, metallic, roughness, normal, occlusion),
        }

    # ------------------------------------------------------------ export
    @staticmethod
    def _export_glb(mesh: Any, filename_prefix: str, save_to_output: bool, ui: dict[str, Any]):
        save_3d = importlib.import_module("comfy_extras.nodes_save_3d")
        glb_bytes = save_3d.mesh_item_to_glb_bytes(mesh, 0)
        if not glb_bytes:
            raise RuntimeError("GLB 导出失败：网格为空。")

        if save_to_output:
            full_folder, filename, counter, subfolder, resolved_prefix = folder_paths.get_save_image_path(
                filename_prefix, folder_paths.get_output_directory())
            file_name = f"{filename}_{counter:05}_.glb"
            os.makedirs(full_folder, exist_ok=True)
            with open(os.path.join(full_folder, file_name), "wb") as handle:
                handle.write(glb_bytes)
            ui["3d"] = [{
                "filename": file_name,
                "subfolder": subfolder,
                "type": "output",
            }]
            return _make_file3d(os.path.join(full_folder, file_name), "glb")

        return _make_file3d(io.BytesIO(glb_bytes), "glb")


# VAE 在管线中多处复用，做一个进程内简易缓存（按模型名）
_VAE_CACHE: dict[str, Any] = {}


def _load_vae(vae_name: str) -> Any:
    if vae_name in _VAE_CACHE:
        return _VAE_CACHE[vae_name]
    nodes_mod = importlib.import_module("nodes")
    vae = nodes_mod.VAELoader().load_vae(vae_name)[0]
    _VAE_CACHE[vae_name] = vae
    return vae


NODE_CLASS_MAPPINGS = {
    NODE_CLASS_NAME: GJJ_Pixal3DTrellis2ImageToModel,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_CLASS_NAME: "🧊 Pixal3D/Trellis2 图生3D",
}
