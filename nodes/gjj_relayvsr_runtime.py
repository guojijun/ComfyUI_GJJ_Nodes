# -*- coding: utf-8 -*-
"""
GJJ RelayVSR 视频超分运行时（通用封装层）。

设计原则：
1. 不重新实现任何模型逻辑，全部通过 ComfyUI 内核官方节点
   （GetVideoComponents / UNETLoader / RelayVSRConditioning / VAELoader /
     KSampler / VSRDecode / CreateVideo）组合完成，与官方工作流等价。
2. 官方节点参数签名运行时用 INPUT_TYPES 动态探测，内核升级增删参数也不会错位。
3. 模型列举、默认选择、x2/x4 配对校验全部基于文件名 token 通用推导，不写死业务分支。
"""
from __future__ import annotations

import inspect
import os
import re
import time
from typing import Any

import folder_paths

# ───────────────────────── 单一配置源（非业务硬编码） ─────────────────────────
# RelayVSR 家族文件共同关键词，模型树与默认选择都基于它过滤。
MODEL_KEYWORD = "relayvsr"
UNET_FOLDER = "diffusion_models"
VAE_FOLDER = "vae"

# 统一的 GJJ 模型下载地址（与其它 GJJ 节点保持一致）。
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/4b5a36d50e9c"
MODEL_HOME_URL = "https://huggingface.co/Comfy-Org/RelayVSR"

# 官方工作流内置的两套权重配对（仅作默认值提示，运行时仍按 token 通用匹配）。
SCALE_PRESETS: dict[str, dict[str, str]] = {
    "x4": {
        "unet": "relayvsr_x4_int8_convrot.safetensors",
        "vae": "relayvsr_flash_vae_x4_fp32.safetensors",
    },
    "x2": {
        "unet": "relayvsr_x2_lightx2v_int8_convrot.safetensors",
        "vae": "relayvsr_flash_vae_x2_fp32.safetensors",
    },
}

# 文件名中的放大倍数 token，如 relayvsr_x4_... / ..._x2_... → "x4" / "x2"。
_SCALE_TOKEN_RE = re.compile(r"(?:^|[_\-. ])x(\d)(?=$|[_\-. ])", re.IGNORECASE)


# ───────────────────────── 倍率选择（同一节点内切 ×2 / ×4） ─────────────────────────
def available_scale_keys() -> list[str]:
    """按数值升序返回预设里的倍率键，例如 ['x2', 'x4']。"""
    def _weight(key: str) -> int:
        digits = re.sub(r"\D", "", str(key or ""))
        return int(digits) if digits else 0

    return sorted(SCALE_PRESETS.keys(), key=_weight)


def scale_choice_label(scale: str) -> str:
    """内部倍率键 → 界面显示值：'x2' → '×2'。"""
    digits = re.sub(r"\D", "", str(scale or ""))
    return f"×{digits}" if digits else str(scale or "")


def scale_choice_values() -> list[str]:
    """放大倍率下拉框的全部候选；始终至少有一个合法值。"""
    return [scale_choice_label(key) for key in available_scale_keys()] or ["×4"]


def resolve_scale_choice(value: Any, default: str = "x4") -> str:
    """把界面显示值及各种写法（×2 / x2 / 2）统一解析成内部倍率键。"""
    text = str(value or "").strip().lower().replace("×", "x").replace("*", "x")
    match = re.search(r"(\d+)", text)
    if match:
        key = f"x{match.group(1)}"
        if key in SCALE_PRESETS:
            return key
    keys = available_scale_keys()
    return default if default in SCALE_PRESETS else (keys[0] if keys else "x4")


# ───────────────────────── 进度回传 ─────────────────────────
def send_progress(unique_id: Any, text: str) -> None:
    """把阶段文本推给前端状态栏（gjj_node_progress 是 GJJ 通用进度频道）。"""
    if unique_id is None:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


# ───────────────────────── 官方节点通用调用 ─────────────────────────
def _official_class(node_id: str):
    """按节点 ID 取内核官方节点类，缺失时给中文升级提示。"""
    try:
        import nodes as comfy_nodes
    except Exception as exc:  # pragma: no cover - 内核不可用属于环境故障
        raise RuntimeError(f"无法加载 ComfyUI 内核节点表：{type(exc).__name__}: {exc}") from exc

    cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(node_id)
    if cls is None:
        raise RuntimeError(
            f"当前 ComfyUI 内核缺少官方节点【{node_id}】。RelayVSR 需要较新的 ComfyUI 版本，"
            "请升级内核后重试。"
        )
    return cls


def _unwrap_output(value: Any) -> tuple[Any, ...]:
    """兼容旧式返回 tuple 与新式 io.NodeOutput（.args）两种形态。"""
    if value is not None and value.__class__.__name__ == "NodeOutput":
        result = getattr(value, "args", None)
        if result is None:
            result = getattr(value, "result", None)
        return tuple(result) if isinstance(result, (list, tuple)) else (result,)
    if isinstance(value, dict) and "result" in value:
        result = value.get("result")
        return tuple(result) if isinstance(result, (list, tuple)) else (result,)
    return tuple(value) if isinstance(value, (list, tuple)) else (value,)


def _node_instance(cls):
    """为旧式节点创建实例；实例化失败时返回 None（调用方走类级兜底）。"""
    try:
        return cls()
    except Exception:
        return None


def _resolve_executable(cls, node_id: str):
    """
    返回（可调用执行函数, 实例）：
    - 旧式内核节点（UNETLoader / VAELoader / KSampler 等）的 FUNCTION 是实例方法，
      从类上取到的是未绑定函数，直接调用会报 missing 1 required positional argument: 'self'，
      因此必须先实例化再取绑定方法；
    - 新式 io.ComfyNode 的 FUNCTION 是 EXECUTE_NORMALIZED（classmethod），类上取到即可直接调用。
    """
    fn_name = str(getattr(cls, "FUNCTION", "") or "")
    fn = getattr(cls, fn_name, None)
    instance = None
    if inspect.isfunction(fn):
        instance = _node_instance(cls)
        if instance is not None:
            fn = getattr(instance, fn_name)
    if not callable(fn):
        # 兜底：新式节点一定有 EXECUTE_NORMALIZED。
        fn = getattr(cls, "EXECUTE_NORMALIZED", None)
    if not callable(fn):
        raise RuntimeError(f"官方节点【{node_id}】没有可调用的执行函数。")
    return fn, instance


def call_official(node_id: str, **kwargs: Any) -> tuple[Any, ...]:
    """
    通用官方节点调用：
    - 运行时读取 INPUT_TYPES，只传该节点声明过的形参，内核增删参数自动兼容；
    - 自动适配 FUNCTION（旧式实例方法 / 新式 EXECUTE_NORMALIZED 类方法）。
    """
    cls = _official_class(node_id)
    allowed: set[str] = set()
    try:
        schema = cls.INPUT_TYPES()
        for section in ("required", "optional", "hidden"):
            allowed.update((schema.get(section) or {}).keys())
    except Exception:
        allowed = set(kwargs.keys())

    filtered = {key: val for key, val in kwargs.items() if not allowed or key in allowed}
    fn, _instance = _resolve_executable(cls, node_id)

    try:
        return _unwrap_output(fn(**filtered))
    except TypeError as exc:
        # 只有“形参不匹配”才退化为全参数直传；节点内部的 TypeError 必须原样抛出，避免重复执行。
        if "unexpected keyword argument" not in str(exc):
            raise
        return _unwrap_output(fn(**kwargs))


def official_combo_options(node_id: str, input_name: str) -> list[Any]:
    """动态读取官方节点某个 combo 输入的候选列表，避免在本节点硬编码枚举。"""
    cls = _official_class(node_id)
    try:
        schema = cls.INPUT_TYPES()
    except Exception:
        return []
    for section in ("required", "optional"):
        spec = (schema.get(section) or {}).get(input_name)
        if isinstance(spec, (tuple, list)) and spec and isinstance(spec[0], (list, tuple)):
            return list(spec[0])
    return []


# ───────────────────────── 模型列举与通用选择 ─────────────────────────
def list_folder_models(folder: str) -> list[str]:
    """列举某模型目录下的全部文件（含子目录相对路径），失败返回空表。"""
    try:
        return list(folder_paths.get_filename_list(folder))
    except Exception:
        return []


def list_family_models(folder: str, keyword: str = MODEL_KEYWORD) -> list[str]:
    """按家族关键词过滤目录模型；关键词不区分大小写。"""
    needle = str(keyword or "").strip().lower()
    return [name for name in list_folder_models(folder) if not needle or needle in name.lower()]


def extract_scale_token(name: str) -> str:
    """从文件名提取放大倍数 token：'x2' / 'x4'，无法识别返回空串。"""
    match = _SCALE_TOKEN_RE.search(str(name or ""))
    return f"x{match.group(1)}".lower() if match else ""


def pick_default_model(
    folder: str,
    preferred: str,
    scale: str,
    keyword: str = MODEL_KEYWORD,
) -> str:
    """
    通用默认模型选择，优先级：
    1. 目录中存在首选文件（精确匹配相对路径或文件名）；
    2. 同家族 + 同倍数 token 的第一个候选；
    3. 同家族任意候选；
    4. 目录第一个候选；都没有时返回空串（由上层报缺失错误）。
    """
    all_models = list_folder_models(folder)
    if not all_models:
        return ""

    def _same_file(candidate: str, target: str) -> bool:
        target = str(target or "").strip()
        if not target:
            return False
        return candidate == target or os.path.basename(candidate) == os.path.basename(target)

    if preferred:
        for candidate in all_models:
            if _same_file(candidate, preferred):
                return candidate

    family = list_family_models(folder, keyword) or all_models
    scale = str(scale or "").strip().lower()
    if scale:
        scaled = [name for name in family if extract_scale_token(name) == scale]
        if scaled:
            if preferred:
                for candidate in scaled:
                    if _same_file(candidate, preferred):
                        return candidate
            return scaled[0]
    return family[0]


def pick_scaled_model(folder: str, scale: str, preferred: str = "") -> str:
    """严格按倍率挑模型：只返回同倍数候选，没有则返回空串（绝不跨倍率兜底）。"""
    candidates = [
        name for name in list_family_models(folder) if extract_scale_token(name) == scale
    ]
    if not candidates:
        return ""
    if preferred:
        for candidate in candidates:
            if os.path.basename(candidate) == os.path.basename(str(preferred)):
                return candidate
    return candidates[0]


def align_model_to_scale(folder: str, name: str, scale: str, role: str) -> str:
    """
    按所选倍率自动选择模型：
    当前模型倍数与所选倍率一致则原样保留；不一致时自动换成同倍数候选
    （优先官方预设文件名）；同倍率权重缺失时给中文下载提示，不做跨倍率兜底。
    """
    if not scale:
        return name
    if extract_scale_token(name) == scale:
        return name
    preset_key = "unet" if folder == UNET_FOLDER else "vae"
    preferred = (SCALE_PRESETS.get(scale) or {}).get(preset_key, "")
    picked = pick_scaled_model(folder, scale, preferred)
    if picked:
        return picked
    raise RuntimeError(
        f"未找到 RelayVSR {role}的 {scale_choice_label(scale)} 版本：models/{folder} 目录下"
        f"没有文件名带 {scale} 标记的权重。\n"
        f"请下载 {scale_choice_label(scale)} 权重后放入该目录，下载地址：{MODEL_DOWNLOAD_URL}\n"
        f"模型主页：{MODEL_HOME_URL}"
    )


def ensure_model_exists(folder: str, name: str, role: str) -> None:
    """模型缺失时抛出带下载指引的中文错误，不做任何自动下载。"""
    if not str(name or "").strip():
        raise RuntimeError(
            f"RelayVSR {role}为空：models/{folder} 目录下没有可用模型。\n"
            f"请下载 RelayVSR 权重后放入该目录，下载地址：{MODEL_DOWNLOAD_URL}\n"
            f"模型主页：{MODEL_HOME_URL}"
        )
    full_path = None
    try:
        full_path = folder_paths.get_full_path(folder, name)
    except Exception:
        full_path = None
    if not full_path or not os.path.isfile(full_path):
        raise RuntimeError(
            f"RelayVSR {role}缺失：models/{folder}/{name} 不存在。\n"
            f"请下载对应权重并放入 models/{folder} 目录，下载地址：{MODEL_DOWNLOAD_URL}\n"
            f"模型主页：{MODEL_HOME_URL}"
        )


def validate_model_pair(unet_name: str, vae_name: str) -> None:
    """
    x2 / x4 权重不可混用：两个文件名都能识别出倍数 token 且不一致时，
    直接中文报错，避免内核抛出难懂的维度错误。
    """
    unet_scale = extract_scale_token(unet_name)
    vae_scale = extract_scale_token(vae_name)
    if unet_scale and vae_scale and unet_scale != vae_scale:
        raise RuntimeError(
            "RelayVSR 模型配对错误：扩散模型与 VAE 的放大倍数不一致。\n"
            f"  扩散模型：{unet_name}（{unet_scale}）\n"
            f"  VAE：{vae_name}（{vae_scale}）\n"
            "x2 与 x4 权重不能混用，请在 🧠 模型树中选择同倍数的一对模型。"
        )


# ───────────────────────── RelayVSR 七段管线 ─────────────────────────
def run_relayvsr_upscale(
    *,
    video: Any,
    unet_name: str,
    vae_name: str,
    steps: int,
    cfg: float,
    seed: int,
    sampler_name: str,
    scheduler: str,
    detail: float,
    weight_dtype: str,
    bit_depth: Any,
    color_space: str,
    chroma_subsampling: str,
    codec: str,
    unique_id: Any = None,
) -> Any:
    """与官方 RelayVSR 子图完全等价的单节点管线，返回 VIDEO。"""
    started_at = time.perf_counter()

    def _stage(text: str) -> None:
        send_progress(unique_id, text)
        print(f"[GJJ][RelayVSR] {text}")

    _stage("①/6 解析视频组件（帧 / 音频 / 帧率 / 色彩信息）…")
    images, audio, fps, _src_bit_depth, _src_color_space = call_official(
        "GetVideoComponents", video=video
    )

    _stage("②/6 加载 RelayVSR 扩散模型…")
    (model,) = call_official(
        "UNETLoader", unet_name=unet_name, weight_dtype=weight_dtype
    )

    _stage("③/6 构建 VSR 条件与空 Latent…")
    positive, latent = call_official(
        "RelayVSRConditioning", model=model, images=images
    )

    _stage("④/6 加载 RelayVSR Flash VAE…")
    (vae,) = call_official("VAELoader", vae_name=vae_name)

    _stage(f"⑤/6 KSampler 采样（steps={steps}, cfg={cfg}, {sampler_name}/{scheduler}）…")
    # 官方工作流中 negative 与 positive 同源，denoise 固定 1.0（RelayVSR 为全采样）。
    (samples,) = call_official(
        "KSampler",
        model=model,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        positive=positive,
        negative=positive,
        latent_image=latent,
        denoise=1.0,
    )

    _stage("⑥/6 VSR Decode 逐帧解码并重建视频…")
    (out_images,) = call_official(
        "VSRDecode", vae=vae, samples=samples, images=images, detail=detail
    )
    (out_video,) = call_official(
        "CreateVideo",
        images=out_images,
        fps=fps,
        audio=audio,
        bit_depth=bit_depth,
        color_space=color_space,
        chroma_subsampling=chroma_subsampling,
        codec=codec,
    )

    elapsed = time.perf_counter() - started_at
    _stage(f"✅ RelayVSR 放大完成，耗时 {elapsed:.1f} 秒")
    return out_video
