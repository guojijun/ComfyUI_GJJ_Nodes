"""GJJ 音频分离节点 - 基于原版 Mel-Band RoFormer 推理流程。

改动要点：
1. 只保留一个输入口，类型限制为 AUDIO,VIDEO。
2. AUDIO 直接处理；VIDEO / VideoFromFile 自动读取视频音轨。
3. 不再手写 Mel 频谱 / 反 Mel / 随机相位重建，改用原版 MelBandRoformer 模型直接输出时域人声。
4. 增加兼容模式：原版 pack/unpack、显式维度修复、自动兼容。
5. V13：IS_CHANGED / execute 改为纯 **kwargs 读取，避免 ComfyUI 将 audio 命名参数从 kwargs 中提前消费后导致外接输入误判为空；外部输入类型改为 *，提高 AUDIO/VIDEO 兼容性。
6. V14：增加“节点最后一次成功输出”兜底缓存；当下游节点刷新导致本节点被二次请求、但本次请求没有携带上游 AUDIO 时，直接复用上一次成功输出，避免重复报“没有收到输入”。
"""

from __future__ import annotations

import os
import re
import sys
import importlib
import inspect
import site
import traceback
import time
import hashlib
import torch
import torch.nn.functional as F

import folder_paths
from comfy import model_management as mm
from comfy.utils import load_torch_file, ProgressBar

CATEGORY = "GJJ/音频处理"
_scanned_models = None
_cached_models = {}

_COMPAT_AUTO = "自动兼容"
_COMPAT_ORIGINAL = "原版 pack/unpack"
_COMPAT_EXPLICIT = "显式维度修复"
_COMPAT_VALUES = [_COMPAT_AUTO, _COMPAT_ORIGINAL, _COMPAT_EXPLICIT]

NODE_NAME = "GJJ · 音频/视频音轨分离器"
NODE_DISPLAY_NAME = "GJJ · 🎵 音视频人声、背景音分离(Mel-Band RoFormer)"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"
REQUIRED_DEPENDENCIES = (
    {
        "module_name": "numpy",
        "package_name": "numpy",
        "description": "该节点需要 numpy 生成 Mel 滤波器。",
    },
    {
        "module_name": "torchaudio.functional",
        "package_name": "torchaudio",
        "description": "该节点需要 torchaudio.functional 对输入音频重采样到 44100Hz。",
    },
    {
        "module_name": "rotary_embedding_torch",
        "package_name": "rotary-embedding-torch",
        "description": "Mel-Band RoFormer 模型结构需要 rotary_embedding_torch。",
    },
    {
        "module_name": "einops",
        "package_name": "einops",
        "description": "Mel-Band RoFormer 模型结构需要 einops 做张量维度重排。",
    },
)
REQUIRED_MODEL = {
    "label": "MelBandRoformer 模型",
    "subdir": "models/diffusion_models",
    "filename": "MelBandRoformer_fp16.safetensors",
    "download_url": MODEL_DOWNLOAD_URL,
    "description": "Mel-Band RoFormer 人声分离模型。",
}
_RUNTIME_DEP_CACHE = {}

# 步骤1: 导入公共依赖检查函数
try:
    from .common_utils.dependency_checker import (
        load_dependency_at_runtime,
        get_pip_install_command_text,
        build_dependency_model_report,
        print_dependency_model_report,
        _generate_warning_message,
    )
except ImportError:
    try:
        from common_utils.dependency_checker import (
            load_dependency_at_runtime,
            get_pip_install_command_text,
            build_dependency_model_report,
            print_dependency_model_report,
            _generate_warning_message,
        )
    except ImportError:
        load_dependency_at_runtime = None
        get_pip_install_command_text = None
        build_dependency_model_report = None
        print_dependency_model_report = None
        _generate_warning_message = None


def _scan_melband_models():
    """扫描 diffusion_models 目录下的 MelBandRoformer 模型。"""
    global _scanned_models
    if _scanned_models is not None:
        return _scanned_models

    models = []
    try:
        model_dirs = folder_paths.get_folder_paths("diffusion_models")
    except Exception:
        model_dirs = []

    for model_dir in model_dirs:
        if not os.path.exists(model_dir):
            continue
        try:
            for filename in os.listdir(model_dir):
                if re.search(
                    r"MelBandRoformer|Mel[-_ ]?Band[-_ ]?RoFormer",
                    filename,
                    re.IGNORECASE,
                ):
                    models.append(filename)
        except Exception:
            continue

    if not models:
        try:
            models = folder_paths.get_filename_list("diffusion_models")
        except Exception:
            models = []

    models = sorted(set(models))
    if not models:
        models = ["[未找到 MelBandRoformer 模型]"]

    _scanned_models = models
    return models


try:
    import numpy as np
    import torchaudio.functional

    _ = __import__("rotary_embedding_torch")
    _ = __import__("einops")
    _DEPENDENCIES_AVAILABLE = True
    _IMPORT_ERROR = None
except ImportError as exc:
    _DEPENDENCIES_AVAILABLE = False
    _IMPORT_ERROR = str(exc)

_MODEL_CHOICES = _scan_melband_models()
_MODELS_AVAILABLE = bool(_MODEL_CHOICES and _MODEL_CHOICES[0] != "[未找到 MelBandRoformer 模型]")
_MISSING_DEPENDENCIES = [] if _DEPENDENCIES_AVAILABLE else [spec["module_name"] for spec in REQUIRED_DEPENDENCIES]
_MISSING_MODELS = [] if _MODELS_AVAILABLE else [REQUIRED_MODEL]

_ENV_REPORT = None
if build_dependency_model_report is not None:
    _ENV_REPORT = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[
            {
                "module_name": spec["module_name"],
                "package_name": spec["package_name"],
                "display_name": spec["module_name"],
                "description": spec["description"],
            }
            for spec in REQUIRED_DEPENDENCIES
            if not _DEPENDENCIES_AVAILABLE
        ],
        missing_models=_MISSING_MODELS,
        install_packages=[spec["package_name"] for spec in REQUIRED_DEPENDENCIES] if not _DEPENDENCIES_AVAILABLE else [],
        description=(
            "使用 Mel-Band RoFormer 模型进行高质量人声/背景音分离，支持外部音频输入和节点内文件加载"
            if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
            else ""
        ),
        original_error=_IMPORT_ERROR or "",
        model_download_url=MODEL_DOWNLOAD_URL,
    )

def _build_audio_separator_description():
    intro = """
🟢 GJJ · 🎵 音频/视频音轨分离器（Mel-Band RoFormer 原版流程）

【核心功能】
• 人声/背景音分离 - 使用 Mel-Band RoFormer 模型进行高质量音频分离
• 多输入支持 - 支持外部 AUDIO 输入，也支持节点内直接加载音视频文件
• 视频音轨提取 - 自动从视频文件中提取音轨进行分离
• 批量处理友好 - 输出人声、背景声、时长和标签，便于后续处理

📦 运行时依赖：
  • numpy（数值计算，生成 Mel 滤波器）
  • torchaudio（音频重采样）
  • rotary-embedding-torch（模型结构需要）
  • einops（张量维度重排）

📁 模型要求：
  • MelBandRoformer 模型，请放置在 models/diffusion_models/ 目录
"""
    warning = (
        _ENV_REPORT["warning_message"]
        if _ENV_REPORT is not None
        else _generate_warning_message(
            NODE_DISPLAY_NAME,
            dependencies_available=_DEPENDENCIES_AVAILABLE,
            models_available=_MODELS_AVAILABLE,
            missing_dependencies=_MISSING_DEPENDENCIES,
            missing_models=_MISSING_MODELS,
        )
    )
    if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE:
        status = _ENV_REPORT.get("description_message", "✅ 运行依赖正常，模型已就绪。") if _ENV_REPORT else "✅ 运行依赖正常，模型已就绪。"
        return f"{status}\n\n{intro}"

    status = _ENV_REPORT.get("description_message", warning) if _ENV_REPORT else warning
    return f"{status}\n\n{intro}"


# 步骤3: 配置动态 DESCRIPTION
DESCRIPTION = _build_audio_separator_description()

# 控制台彩色输出：只输出具体错误和模型调用情况，不再打印 INPUT_TYPES / IS_CHANGED 等调试噪声。
_ANSI_RESET = "[0m"
_ANSI_RED = "[91m"
_ANSI_GREEN = "[92m"
_ANSI_YELLOW = "[93m"
_ANSI_BLUE = "[94m"
_ANSI_MAGENTA = "[95m"
_ANSI_CYAN = "[96m"


def _color(text, color):
    return f"{color}{text}{_ANSI_RESET}"


def _gjj_log(kind, msg, color=_ANSI_CYAN):
    try:
        print(_color(f"[GJJ 音频分离] {kind} {msg}", color), flush=True)
    except Exception:
        print(f"[GJJ 音频分离] {kind} {msg}")


def _log_model(msg):
    _gjj_log("🎛️ 模型", msg, _ANSI_MAGENTA)


def _log_ok(msg):
    _gjj_log("✅ 完成", msg, _ANSI_GREEN)


def _log_warn(msg):
    _gjj_log("⚠️ 提示", msg, _ANSI_YELLOW)


def _log_error(msg):
    _gjj_log("❌ 错误", msg, _ANSI_RED)


def _diag(msg):
    # 保留函数名以兼容旧代码，但默认静默。
    return None


def _get_site_packages_target():
    """返回当前 ComfyUI Python 的 site-packages 路径，用于 pip --target。"""
    candidates = []
    try:
        candidates.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        user_site = site.getusersitepackages()
        if user_site:
            candidates.append(user_site)
    except Exception:
        pass

    for path in candidates:
        if path and "site-packages" in str(path):
            return path

    # Windows embedded Python 常见路径：python_embeded/Lib/site-packages
    return os.path.join(sys.prefix, "Lib", "site-packages")


def _build_pip_command(packages):
    """内置 fallback：生成带清华源和 --target 的安装命令。"""
    pkgs = " ".join(dict.fromkeys([str(p).strip() for p in packages if str(p).strip()]))
    target = _get_site_packages_target()
    return (
        f'"{sys.executable}" -m pip install {pkgs} '
        f'--target "{target}" '
        "-i https://pypi.tuna.tsinghua.edu.cn/simple"
    )


def _load_dependency_checker_module():
    """运行时加载 GJJ 公共依赖提示工具；不存在时返回 None。"""
    try:
        try:
            from .common_utils import dependency_checker as checker
        except Exception:
            from common_utils import dependency_checker as checker
        return checker
    except Exception:
        return None


def _call_get_pip_install_command_text(func, packages):
    """兼容不同版本 get_pip_install_command_text 的函数签名。"""
    packages = list(dict.fromkeys([str(p).strip() for p in packages if str(p).strip()]))
    attempts = [
        lambda: func(packages=packages),
        lambda: func(package_names=packages),
        lambda: func(pip_packages=packages),
        lambda: func(package_name=packages[0] if packages else ""),
        lambda: func(" ".join(packages)),
        lambda: func(packages),
    ]
    for call in attempts:
        try:
            text = call()
            if text:
                return str(text)
        except Exception:
            continue
    return _build_pip_command(packages)


def _print_friendly_dependency_error(
    *, module_name, packages, description, original_error
):
    """控制台友好输出。优先使用 common_utils.dependency_checker，失败时用内置彩色提示。"""
    checker = _load_dependency_checker_module()
    packages = list(dict.fromkeys([str(p).strip() for p in packages if str(p).strip()]))
    report = None

    if checker is not None and hasattr(checker, "build_dependency_model_report"):
        report = checker.build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": module_name,
                    "package_name": packages[0] if packages else module_name,
                    "display_name": module_name,
                    "description": description,
                }
            ],
            install_packages=packages,
            original_error=str(original_error or ""),
        )
        report["node_name"] = NODE_DISPLAY_NAME
        if hasattr(checker, "print_dependency_model_report"):
            checker.print_dependency_model_report(report, title="GJJ 节点运行时依赖缺失！")
            return report.get("install_cmd", "") or _build_pip_command(packages)

    pip_cmd = _build_pip_command(packages)
    if report is None:
        report = {
            "node_name": NODE_DISPLAY_NAME,
            "missing_dependencies": [
                {
                    "module_name": module_name,
                    "package_name": packages[0] if packages else module_name,
                    "display_name": module_name,
                    "description": description,
                }
            ],
            "missing_models": [],
            "install_cmd": pip_cmd,
        }

    red = "\033[91m"
    yellow = "\033[93m"
    cyan = "\033[96m"
    green = "\033[92m"
    reset = "\033[0m"
    line = "=" * 90
    print(f"\n{red}{line}{reset}")
    print(f"{red}  GJJ 节点运行时依赖缺失！{reset}")
    print(f"{red}{line}{reset}")
    print(f"{yellow}[GJJ] {reset}节点: {cyan}{NODE_DISPLAY_NAME}{reset}")
    print(f"{yellow}[GJJ] {reset}缺失依赖: {red}{module_name}{reset}")
    if description:
        print(f"{yellow}[GJJ] {reset}{description}")
    print(f"\n{yellow}[GJJ] {reset}快速安装命令:")
    print(f"{green}{pip_cmd}{reset}")
    print(f"\n{yellow}[GJJ] {reset}提示: 安装后请重启 ComfyUI 服务器")
    if original_error:
        print(f"{yellow}[GJJ] {reset}原始错误: {original_error}")
    print(f"{red}{line}{reset}\n")
    return pip_cmd


def _runtime_import(
    module_name, *, package_name=None, description="", extra_packages=None
):
    """运行时按需导入依赖；节点启动时不检查、不导入重型包。"""
    cache_key = module_name
    if cache_key in _RUNTIME_DEP_CACHE:
        return _RUNTIME_DEP_CACHE[cache_key]

    packages = []
    if package_name:
        packages.append(package_name)
    else:
        packages.append(module_name.split(".")[0])
    if extra_packages:
        packages.extend(extra_packages)
    packages = list(dict.fromkeys(packages))

    # 优先使用 GJJ 项目已有统一加载器；它内部通常已经包含缓存和友好提示。
    checker = _load_dependency_checker_module()
    if checker is not None and hasattr(checker, "load_dependency_at_runtime"):
        pass

    # 没有公共加载器时，使用 importlib + 内置友好提示。
    try:
        mod = importlib.import_module(module_name)
        _RUNTIME_DEP_CACHE[cache_key] = mod
        return mod
    except Exception as import_error:
        report = None
        if checker is not None and hasattr(checker, "build_dependency_model_report"):
            report = checker.build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[
                    {
                        "module_name": module_name,
                        "package_name": package_name or module_name,
                        "display_name": module_name,
                        "description": description,
                    }
                ],
                install_packages=packages,
                original_error=str(import_error),
            )
            report["node_name"] = NODE_DISPLAY_NAME
            if hasattr(checker, "print_dependency_model_report"):
                checker.print_dependency_model_report(report, title="GJJ 节点运行时依赖缺失！")
        if report is None:
            pip_cmd = _build_pip_command(packages)
            report = {
                "node_name": NODE_DISPLAY_NAME,
                "missing_dependencies": [
                    {
                        "module_name": module_name,
                        "package_name": package_name or module_name,
                        "display_name": module_name,
                        "description": description,
                    }
                ],
                "missing_models": [],
                "install_cmd": pip_cmd,
                "warning_message": _generate_warning_message(
                    NODE_DISPLAY_NAME,
                    dependencies_available=False,
                    models_available=True,
                    missing_dependencies=[module_name],
                    missing_models=[],
                ),
                "panel_message": (
                    f"⚠️缺失运行依赖 {module_name}，点击❓按钮了解详情。\n\n"
                    f"📦 必需依赖（请安装）：\n• {package_name or module_name}"
                ),
                "help_message": "",
                "console_message": "",
            }
        pip_cmd = report.get("install_cmd") or _build_pip_command(packages)
        _LAST_INSTALL_CMD = pip_cmd
        _LAST_MISSING_MODULE = module_name
        _LAST_DESCRIPTION = description
        err = RuntimeError((report or {}).get("panel_message") or f"未找到 {module_name} 运行库。")
        setattr(err, "gjj_report", report or {})
        raise err from import_error


# 用于存储最后一次依赖检查失败时的信息
_LAST_INSTALL_CMD = ""
_LAST_MISSING_MODULE = ""
_LAST_DESCRIPTION = ""


class _LazyDependency:
    """仅在真正访问属性时才 import 的轻量代理。"""

    def __init__(
        self, module_name, package_name=None, description="", extra_packages=None
    ):
        self.module_name = module_name
        self.package_name = package_name
        self.description = description
        self.extra_packages = extra_packages or []

    def _load(self):
        return _runtime_import(
            self.module_name,
            package_name=self.package_name,
            description=self.description,
            extra_packages=self.extra_packages,
        )

    def __getattr__(self, item):
        return getattr(self._load(), item)


np = _LazyDependency(
    "numpy",
    package_name="numpy",
    description="该节点需要 numpy 生成 Mel 滤波器。ComfyUI 通常已自带该依赖。",
)


def _get_torchaudio_functional():
    return _runtime_import(
        "torchaudio.functional",
        package_name="torchaudio",
        description="该节点需要 torchaudio.functional 对输入音频重采样到 Mel-Band RoFormer 需要的 44100Hz。ComfyUI 音频节点通常已安装 torchaudio。",
    )


def _get_rotary_embedding_class():
    mod = _runtime_import(
        "rotary_embedding_torch",
        package_name="rotary-embedding-torch",
        description="Mel-Band RoFormer 模型结构需要 rotary_embedding_torch。",
    )
    return mod.RotaryEmbedding


def _get_einops_func(name):
    mod = _runtime_import(
        "einops",
        package_name="einops",
        description="Mel-Band RoFormer 模型结构需要 einops 做张量维度重排。ComfyUI 通常已自带该依赖。",
    )
    return getattr(mod, name)


def rearrange(*args, **kwargs):
    return _get_einops_func("rearrange")(*args, **kwargs)


def pack(*args, **kwargs):
    return _get_einops_func("pack")(*args, **kwargs)


def unpack(*args, **kwargs):
    return _get_einops_func("unpack")(*args, **kwargs)


def reduce(*args, **kwargs):
    return _get_einops_func("reduce")(*args, **kwargs)


def repeat(*args, **kwargs):
    return _get_einops_func("repeat")(*args, **kwargs)


# ============================================================================
# 内置 Mel 转换工具（原 mel_converter.py）
# ============================================================================


# following is from librosa


def hz_to_mel(frequencies, *, htk=False):
    frequencies = np.asanyarray(frequencies)

    if htk:
        mels: np.ndarray = 2595.0 * np.log10(1.0 + frequencies / 700.0)
        return mels

    # Fill in the linear part
    f_min = 0.0
    f_sp = 200.0 / 3

    mels = (frequencies - f_min) / f_sp

    # Fill in the log-scale part

    min_log_hz = 1000.0  # beginning of log region (Hz)
    min_log_mel = (min_log_hz - f_min) / f_sp  # same (Mels)
    logstep = np.log(6.4) / 27.0  # step size for log region

    if frequencies.ndim:
        # If we have array data, vectorize
        log_t = frequencies >= min_log_hz
        mels[log_t] = min_log_mel + np.log(frequencies[log_t] / min_log_hz) / logstep
    elif frequencies >= min_log_hz:
        # If we have scalar data, heck directly
        mels = min_log_mel + np.log(frequencies / min_log_hz) / logstep

    return mels


def mel_to_hz(mels, *, htk=False):
    mels = np.asanyarray(mels)

    if htk:
        return 700.0 * (10.0 ** (mels / 2595.0) - 1.0)

    # Fill in the linear scale
    f_min = 0.0
    f_sp = 200.0 / 3
    freqs = f_min + f_sp * mels

    # And now the nonlinear scale
    min_log_hz = 1000.0  # beginning of log region (Hz)
    min_log_mel = (min_log_hz - f_min) / f_sp  # same (Mels)
    logstep = np.log(6.4) / 27.0  # step size for log region

    if mels.ndim:
        # If we have vector data, vectorize
        log_t = mels >= min_log_mel
        freqs[log_t] = min_log_hz * np.exp(logstep * (mels[log_t] - min_log_mel))
    elif mels >= min_log_mel:
        # If we have scalar data, check directly
        freqs = min_log_hz * np.exp(logstep * (mels - min_log_mel))

    return freqs


def mel_frequencies(n_mels=128, *, fmin=0.0, fmax=11025.0, htk=False):
    min_mel = hz_to_mel(fmin, htk=htk)
    max_mel = hz_to_mel(fmax, htk=htk)
    mels = np.linspace(min_mel, max_mel, n_mels)
    hz: np.ndarray = mel_to_hz(mels, htk=htk)
    return hz


def fft_frequencies(*, sr: float = 22050, n_fft: int = 2048) -> np.ndarray:
    return np.fft.rfftfreq(n=n_fft, d=1.0 / sr)


def librosa_mel_fn(
    *,
    sr: float,
    n_fft: int,
    n_mels: int = 128,
    fmin: float = 0.0,
    fmax=None,
    htk=False,
    norm="slaney",
    dtype=np.float32,
) -> np.ndarray:

    if fmax is None:
        fmax = float(sr) / 2

    # Initialize the weights
    n_mels = int(n_mels)
    weights = np.zeros((n_mels, int(1 + n_fft // 2)), dtype=dtype)

    # Center freqs of each FFT bin
    fftfreqs = fft_frequencies(sr=sr, n_fft=n_fft)

    # 'Center freqs' of mel bands - uniformly spaced between limits
    mel_f = mel_frequencies(n_mels + 2, fmin=fmin, fmax=fmax, htk=htk)

    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)

    for i in range(n_mels):
        # lower and upper slopes for all bins
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]

        # .. then intersect them with each other and zero
        weights[i] = np.maximum(0, np.minimum(lower, upper))

    # Slaney-style mel is scaled to be approx constant energy per channel
    enorm = 2.0 / (mel_f[2 : n_mels + 2] - mel_f[:n_mels])
    weights *= enorm[:, np.newaxis]

    return weights


# ============================================================================
# 内置 MelBandRoformer 模型结构（原 mel_band_roformer.py）
# ============================================================================

# https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model/blob/main/models/mel_band_roformer/mel_band_roformer.py

from functools import partial
from torch import nn
from torch.nn import Module, ModuleList

# helper functions


def exists(val):
    return val is not None


def default(v, d):
    return v if exists(v) else d


def pack_one(t, pattern):
    return pack([t], pattern)


def unpack_one(t, ps, pattern):
    return unpack(t, ps, pattern)[0]


def pad_at_dim(t, pad, dim=-1, value=0.0):
    dims_from_right = (-dim - 1) if dim < 0 else (t.ndim - dim - 1)
    zeros = (0, 0) * dims_from_right
    return F.pad(t, (*zeros, *pad), value=value)


# norm


class RMSNorm(Module):
    def __init__(self, dim):
        super().__init__()
        self.scale = dim**0.5
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        return F.normalize(x, dim=-1) * self.scale * self.gamma


# attention


class FeedForward(Module):
    def __init__(self, dim, mult=4, dropout=0.0):
        super().__init__()
        dim_inner = int(dim * mult)
        self.net = nn.Sequential(
            RMSNorm(dim),
            nn.Linear(dim, dim_inner),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim_inner, dim),
            nn.Dropout(dropout),
        )

    def forward(self, x):
        return self.net(x)


class Attention(Module):
    def __init__(
        self,
        dim,
        heads=8,
        dim_head=64,
        dropout=0.0,
        rotary_embed=None,
    ):
        super().__init__()
        self.heads = heads
        self.scale = dim_head**-0.5
        dim_inner = heads * dim_head

        self.rotary_embed = rotary_embed

        self.attend = F.scaled_dot_product_attention

        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, dim_inner * 3, bias=False)

        self.to_gates = nn.Linear(dim, heads)

        self.to_out = nn.Sequential(
            nn.Linear(dim_inner, dim, bias=False), nn.Dropout(dropout)
        )

    def forward(self, x):
        x = self.norm(x)

        q, k, v = rearrange(
            self.to_qkv(x), "b n (qkv h d) -> qkv b h n d", qkv=3, h=self.heads
        )

        if exists(self.rotary_embed):
            q = self.rotary_embed.rotate_queries_or_keys(q)
            k = self.rotary_embed.rotate_queries_or_keys(k)

        out = self.attend(q, k, v)

        gates = self.to_gates(x)
        out = out * rearrange(gates, "b n h -> b h n 1").sigmoid()

        out = rearrange(out, "b h n d -> b n (h d)")
        return self.to_out(out)


class Transformer(Module):
    def __init__(
        self,
        *,
        dim,
        depth,
        dim_head=64,
        heads=8,
        attn_dropout=0.0,
        ff_dropout=0.0,
        ff_mult=4,
        norm_output=True,
        rotary_embed=None,
        flash_attn=True,
    ):
        super().__init__()
        self.layers = ModuleList([])

        for _ in range(depth):
            self.layers.append(
                ModuleList(
                    [
                        Attention(
                            dim=dim,
                            dim_head=dim_head,
                            heads=heads,
                            dropout=attn_dropout,
                            rotary_embed=rotary_embed,
                        ),
                        FeedForward(dim=dim, mult=ff_mult, dropout=ff_dropout),
                    ]
                )
            )

        self.norm = RMSNorm(dim) if norm_output else nn.Identity()

    def forward(self, x):

        for attn, ff in self.layers:
            x = attn(x) + x
            x = ff(x) + x

        return self.norm(x)


# bandsplit module


class BandSplit(Module):
    def __init__(self, dim, dim_inputs):
        super().__init__()
        self.dim_inputs = dim_inputs
        self.to_features = ModuleList([])

        for dim_in in dim_inputs:
            net = nn.Sequential(RMSNorm(dim_in), nn.Linear(dim_in, dim))

            self.to_features.append(net)

    def forward(self, x):
        x = x.split(self.dim_inputs, dim=-1)

        outs = []
        for split_input, to_feature in zip(x, self.to_features):
            split_output = to_feature(split_input)
            outs.append(split_output)

        return torch.stack(outs, dim=-2)


def MLP(dim_in, dim_out, dim_hidden=None, depth=1, activation=nn.Tanh):
    dim_hidden = default(dim_hidden, dim_in)

    net = []
    dims = (dim_in, *((dim_hidden,) * depth), dim_out)

    for ind, (layer_dim_in, layer_dim_out) in enumerate(zip(dims[:-1], dims[1:])):
        is_last = ind == (len(dims) - 2)

        net.append(nn.Linear(layer_dim_in, layer_dim_out))

        if is_last:
            continue

        net.append(activation())

    return nn.Sequential(*net)


class MaskEstimator(Module):
    def __init__(self, dim, dim_inputs, depth, mlp_expansion_factor=4):
        super().__init__()
        self.dim_inputs = dim_inputs
        self.to_freqs = ModuleList([])
        dim_hidden = dim * mlp_expansion_factor

        for dim_in in dim_inputs:
            net = []

            mlp = nn.Sequential(
                MLP(dim, dim_in * 2, dim_hidden=dim_hidden, depth=depth), nn.GLU(dim=-1)
            )

            self.to_freqs.append(mlp)

    def forward(self, x):
        x = x.unbind(dim=-2)

        outs = []

        for band_features, mlp in zip(x, self.to_freqs):
            freq_out = mlp(band_features)
            outs.append(freq_out)

        return torch.cat(outs, dim=-1)


# main class


class MelBandRoformer(Module):
    def __init__(
        self,
        dim,
        *,
        depth,
        stereo=False,
        num_stems=1,
        time_transformer_depth=2,
        freq_transformer_depth=2,
        num_bands=60,
        dim_head=64,
        heads=8,
        attn_dropout=0.1,
        ff_dropout=0.1,
        flash_attn=True,
        dim_freqs_in=1025,
        sample_rate=44100,  # needed for mel filter bank from librosa
        stft_n_fft=2048,
        stft_hop_length=512,
        # 10ms at 44100Hz, from sections 4.1, 4.4 in the paper - @faroit recommends // 2 or // 4 for better reconstruction
        stft_win_length=2048,
        stft_normalized=False,
        stft_window_fn=None,
        mask_estimator_depth=1,
        multi_stft_resolution_loss_weight=1.0,
        multi_stft_resolutions_window_sizes=(4096, 2048, 1024, 512, 256),
        multi_stft_hop_size=147,
        multi_stft_normalized=False,
        multi_stft_window_fn=torch.hann_window,
        match_input_audio_length=False,  # if True, pad output tensor to match length of input tensor
    ):
        super().__init__()

        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems

        self.layers = ModuleList([])

        transformer_kwargs = dict(
            dim=dim,
            heads=heads,
            dim_head=dim_head,
            attn_dropout=attn_dropout,
            ff_dropout=ff_dropout,
            flash_attn=flash_attn,
        )

        RotaryEmbedding = _get_rotary_embedding_class()
        time_rotary_embed = RotaryEmbedding(dim=dim_head)
        freq_rotary_embed = RotaryEmbedding(dim=dim_head)

        for _ in range(depth):
            self.layers.append(
                nn.ModuleList(
                    [
                        Transformer(
                            depth=time_transformer_depth,
                            rotary_embed=time_rotary_embed,
                            **transformer_kwargs,
                        ),
                        Transformer(
                            depth=freq_transformer_depth,
                            rotary_embed=freq_rotary_embed,
                            **transformer_kwargs,
                        ),
                    ]
                )
            )

        self.stft_window_fn = partial(
            default(stft_window_fn, torch.hann_window), stft_win_length
        )

        self.stft_kwargs = dict(
            n_fft=stft_n_fft,
            hop_length=stft_hop_length,
            win_length=stft_win_length,
            normalized=stft_normalized,
        )

        freqs = torch.stft(
            torch.randn(1, 4096), **self.stft_kwargs, return_complex=True
        ).shape[1]

        # create mel filter bank
        # with librosa.filters.mel as in section 2 of paper

        mel_filter_bank_numpy = librosa_mel_fn(
            sr=sample_rate, n_fft=stft_n_fft, n_mels=num_bands
        )

        mel_filter_bank = torch.from_numpy(mel_filter_bank_numpy)

        # for some reason, it doesn't include the first freq? just force a value for now

        mel_filter_bank[0][0] = 1.0

        # In some systems/envs we get 0.0 instead of ~1.9e-18 in the last position,
        # so let's force a positive value

        mel_filter_bank[-1, -1] = 1.0

        # binary as in paper (then estimated masks are averaged for overlapping regions)

        freqs_per_band = mel_filter_bank > 0
        assert freqs_per_band.any(
            dim=0
        ).all(), "all frequencies need to be covered by all bands for now"

        repeated_freq_indices = repeat(torch.arange(freqs), "f -> b f", b=num_bands)
        freq_indices = repeated_freq_indices[freqs_per_band]

        if stereo:
            freq_indices = repeat(freq_indices, "f -> f s", s=2)
            freq_indices = freq_indices * 2 + torch.arange(2)
            freq_indices = rearrange(freq_indices, "f s -> (f s)")

        self.register_buffer("freq_indices", freq_indices, persistent=False)
        self.register_buffer("freqs_per_band", freqs_per_band, persistent=False)

        num_freqs_per_band = reduce(freqs_per_band, "b f -> b", "sum")
        num_bands_per_freq = reduce(freqs_per_band, "b f -> f", "sum")

        self.register_buffer("num_freqs_per_band", num_freqs_per_band, persistent=False)
        self.register_buffer("num_bands_per_freq", num_bands_per_freq, persistent=False)

        # band split and mask estimator

        freqs_per_bands_with_complex = tuple(
            2 * f * self.audio_channels for f in num_freqs_per_band.tolist()
        )

        self.band_split = BandSplit(dim=dim, dim_inputs=freqs_per_bands_with_complex)

        self.mask_estimators = nn.ModuleList([])

        for _ in range(num_stems):
            mask_estimator = MaskEstimator(
                dim=dim,
                dim_inputs=freqs_per_bands_with_complex,
                depth=mask_estimator_depth,
            )

            self.mask_estimators.append(mask_estimator)

        # for the multi-resolution stft loss

        self.multi_stft_resolution_loss_weight = multi_stft_resolution_loss_weight
        self.multi_stft_resolutions_window_sizes = multi_stft_resolutions_window_sizes
        self.multi_stft_n_fft = stft_n_fft
        self.multi_stft_window_fn = multi_stft_window_fn

        self.multi_stft_kwargs = dict(
            hop_length=multi_stft_hop_size, normalized=multi_stft_normalized
        )

        self.match_input_audio_length = match_input_audio_length

    def forward(self, raw_audio, target=None, return_loss_breakdown=False):
        """
        einops

        b - batch
        f - freq
        t - time
        s - audio channel (1 for mono, 2 for stereo)
        n - number of 'stems'
        c - complex (2)
        d - feature dimension
        """

        device = raw_audio.device

        if raw_audio.ndim == 2:
            raw_audio = rearrange(raw_audio, "b t -> b 1 t")

        batch, channels, raw_audio_length = raw_audio.shape

        istft_length = raw_audio_length if self.match_input_audio_length else None

        assert (not self.stereo and channels == 1) or (
            self.stereo and channels == 2
        ), "stereo needs to be set to True if passing in audio signal that is stereo (channel dimension of 2). also need to be False if mono (channel dimension of 1)"

        # to stft
        # 不再使用 einops.pack / unpack，避免某些环境下解包后丢失 batch 维度，
        # 导致后续出现 expected 4 dims but received 3 dims。
        raw_audio = rearrange(raw_audio, "b s t -> (b s) t")

        stft_window = self.stft_window_fn(device=device)

        stft_repr = torch.stft(
            raw_audio, **self.stft_kwargs, window=stft_window, return_complex=True
        )
        stft_repr = torch.view_as_real(stft_repr)

        stft_repr = rearrange(
            stft_repr, "(b s) f t c -> b s f t c", b=batch, s=channels
        )
        stft_repr = rearrange(
            stft_repr, "b s f t c -> b (f s) t c"
        )  # merge stereo / mono into the frequency, with frequency leading dimension, for band splitting

        # index out all frequencies for all frequency ranges across bands ascending in one go

        batch_arange = torch.arange(batch, device=device)[..., None]

        # account for stereo

        x = stft_repr[batch_arange, self.freq_indices]

        # fold the complex (real and imag) into the frequencies dimension

        x = rearrange(x, "b f t c -> b t (f c)")

        x = self.band_split(x)

        # axial / hierarchical attention

        compat_mode = getattr(self, "_gjj_compatibility_mode", _COMPAT_ORIGINAL)
        use_original_pack = compat_mode == _COMPAT_ORIGINAL

        for time_transformer, freq_transformer in self.layers:
            if use_original_pack:
                # 原版路径：完全按 mel_band_roformer.py 使用 einops.pack / unpack。
                x = rearrange(x, "b t f d -> b f t d")
                x, ps = pack([x], "* t d")

                x = time_transformer(x)

                (x,) = unpack(x, ps, "* t d")
                x = rearrange(x, "b f t d -> b t f d")
                x, ps = pack([x], "* f d")

                x = freq_transformer(x)

                (x,) = unpack(x, ps, "* f d")
            else:
                # 兼容路径：不用 pack / unpack，显式合并和还原维度。
                # 适合部分 einops 版本在 unpack 后丢 batch 维的环境。
                x = rearrange(x, "b t f d -> b f t d")
                b_, f_, t_, d_ = x.shape
                x = rearrange(x, "b f t d -> (b f) t d")

                x = time_transformer(x)

                x = rearrange(x, "(b f) t d -> b f t d", b=b_, f=f_)
                x = rearrange(x, "b f t d -> b t f d")

                b_, t_, f_, d_ = x.shape
                x = rearrange(x, "b t f d -> (b t) f d")

                x = freq_transformer(x)

                x = rearrange(x, "(b t) f d -> b t f d", b=b_, t=t_)

        num_stems = len(self.mask_estimators)

        masks = torch.stack([fn(x) for fn in self.mask_estimators], dim=1)
        masks = rearrange(masks, "b n t (f c) -> b n f t c", c=2)

        # modulate frequency representation

        stft_repr = rearrange(stft_repr, "b f t c -> b 1 f t c")

        # complex number multiplication

        stft_repr = torch.view_as_complex(stft_repr)
        masks = torch.view_as_complex(masks)

        masks = masks.type(stft_repr.dtype)

        # need to average the estimated mask for the overlapped frequencies

        scatter_indices = repeat(
            self.freq_indices,
            "f -> b n f t",
            b=batch,
            n=num_stems,
            t=stft_repr.shape[-1],
        )

        stft_repr_expanded_stems = repeat(stft_repr, "b 1 ... -> b n ...", n=num_stems)
        masks_summed = torch.zeros_like(stft_repr_expanded_stems).scatter_add_(
            2, scatter_indices, masks
        )

        denom = repeat(self.num_bands_per_freq, "f -> (f r) 1", r=channels)

        masks_averaged = masks_summed / denom.clamp(min=1e-8)

        # modulate stft repr with estimated mask

        stft_repr = stft_repr * masks_averaged

        # istft

        stft_repr = rearrange(
            stft_repr, "b n (f s) t -> (b n s) f t", s=self.audio_channels
        )

        recon_audio = torch.istft(
            stft_repr,
            **self.stft_kwargs,
            window=stft_window,
            return_complex=False,
            length=istft_length,
        )

        recon_audio = rearrange(
            recon_audio,
            "(b n s) t -> b n s t",
            b=batch,
            s=self.audio_channels,
            n=num_stems,
        )

        if num_stems == 1:
            recon_audio = rearrange(recon_audio, "b 1 s t -> b s t")

        # if a target is passed in, calculate loss for learning

        if not exists(target):
            return recon_audio

        if self.num_stems > 1:
            assert target.ndim == 4 and target.shape[1] == self.num_stems

        if target.ndim == 2:
            target = rearrange(target, "... t -> ... 1 t")

        target = target[
            ..., : recon_audio.shape[-1]
        ]  # protect against lost length on istft

        loss = F.l1_loss(recon_audio, target)

        multi_stft_resolution_loss = 0.0

        for window_size in self.multi_stft_resolutions_window_sizes:
            res_stft_kwargs = dict(
                n_fft=max(
                    window_size, self.multi_stft_n_fft
                ),  # not sure what n_fft is across multi resolution stft
                win_length=window_size,
                return_complex=True,
                window=self.multi_stft_window_fn(window_size, device=device),
                **self.multi_stft_kwargs,
            )

            recon_Y = torch.stft(
                rearrange(recon_audio, "... s t -> (... s) t"), **res_stft_kwargs
            )
            target_Y = torch.stft(
                rearrange(target, "... s t -> (... s) t"), **res_stft_kwargs
            )

            multi_stft_resolution_loss = multi_stft_resolution_loss + F.l1_loss(
                recon_Y, target_Y
            )

        weighted_multi_resolution_loss = (
            multi_stft_resolution_loss * self.multi_stft_resolution_loss_weight
        )

        total_loss = loss + weighted_multi_resolution_loss

        if not return_loss_breakdown:
            return total_loss

        return total_loss, (loss, multi_stft_resolution_loss)


# ============================================================================
# GJJ 节点逻辑
# ============================================================================


def _scan_melband_models():
    """扫描 diffusion_models 目录下的 MelBandRoformer 模型。"""
    global _scanned_models
    if _scanned_models is not None:
        return _scanned_models

    models = []
    try:
        model_dirs = folder_paths.get_folder_paths("diffusion_models")
    except Exception:
        model_dirs = []

    for model_dir in model_dirs:
        if not os.path.exists(model_dir):
            continue
        try:
            for filename in os.listdir(model_dir):
                if re.search(
                    r"MelBandRoformer|Mel[-_ ]?Band[-_ ]?RoFormer",
                    filename,
                    re.IGNORECASE,
                ):
                    models.append(filename)
        except Exception:
            continue

    # 找不到时退回全部 diffusion_models，避免文件名不含 MelBandRoformer 时无法选择。
    if not models:
        try:
            models = folder_paths.get_filename_list("diffusion_models")
        except Exception:
            models = []

    models = sorted(set(models))
    if not models:
        models = ["[未找到 MelBandRoformer 模型]"]

    _scanned_models = models
    return models


_AUDIO_EXTS = {
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".m4a",
    ".aac",
    ".wma",
    ".aiff",
    ".aif",
    ".opus",
}
_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv"}
_MEDIA_SENTINEL = "🔌 外接音频优先"
_OLD_MEDIA_SENTINELS = {"🔌 使用连接输入", "[不加载]", "", None}


def _scan_input_media_files():
    """扫描 ComfyUI input 目录中的音频/视频文件，供节点内部直接加载。"""
    files = [_MEDIA_SENTINEL]
    roots = []
    try:
        roots.append(folder_paths.get_input_directory())
    except Exception:
        pass
    try:
        # 部分环境支持 annotated file 列表；失败时忽略。
        roots.extend(folder_paths.get_folder_paths("input"))
    except Exception:
        pass

    seen_roots = []
    for root in roots:
        if root and os.path.isdir(root) and root not in seen_roots:
            seen_roots.append(root)

    found = []
    for root in seen_roots:
        try:
            for dirpath, _, filenames in os.walk(root):
                for name in filenames:
                    ext = os.path.splitext(name)[1].lower()
                    if ext not in _AUDIO_EXTS and ext not in _VIDEO_EXTS:
                        continue
                    full = os.path.join(dirpath, name)
                    try:
                        rel = os.path.relpath(full, root).replace("\\", "/")
                    except Exception:
                        rel = name
                    found.append(rel)
        except Exception:
            continue

    files.extend(sorted(set(found), key=lambda x: x.lower()))
    return files


def _resolve_input_media_file(media_file):
    """把 input 目录下的相对文件名解析成真实路径。"""
    if media_file in _OLD_MEDIA_SENTINELS or media_file == _MEDIA_SENTINEL:
        return None
    raw = os.fspath(media_file)
    try:
        if folder_paths.exists_annotated_filepath(raw):
            return folder_paths.get_annotated_filepath(raw)
    except Exception:
        pass
    if os.path.isabs(raw) and os.path.exists(raw):
        return raw
    try:
        root = folder_paths.get_input_directory()
        candidate = os.path.abspath(os.path.join(root, raw))
        # 防止路径穿越 input 目录。
        if os.path.commonpath([os.path.abspath(root), candidate]) == os.path.abspath(
            root
        ) and os.path.exists(candidate):
            return candidate
    except Exception:
        pass
    try:
        candidate = folder_paths.get_annotated_filepath(raw)
        if candidate and os.path.exists(candidate):
            return candidate
    except Exception:
        pass
    raise RuntimeError(
        f"找不到媒体文件：{media_file}\n请把音频/视频放到 ComfyUI/input/ 目录后刷新节点。"
    )


def _load_audio_from_file(media_file):
    """节点内部直接加载 input 目录中的音频/视频；视频只读取音轨。"""
    path = _resolve_input_media_file(media_file)
    if path is None:
        return None
    try:
        from comfy_extras.nodes_audio import load as comfy_load_audio

        waveform, sample_rate = comfy_load_audio(path)
        return _normalize_comfy_audio(
            {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
        )
    except Exception as e:
        raise RuntimeError(
            "内部加载媒体失败。\n"
            "支持常见音频格式，也支持从常见视频格式中读取音轨；如果失败，通常是文件没有音轨或 PyAV/ffmpeg 依赖不可用。\n"
            f"文件：{path}\n"
            f"底层错误：{e}"
        )


def _format_audio_tag(audio_tag, media_file=None):
    """生成给后续节点/日志使用的音频标签。"""
    tag = str(audio_tag or "input_audio").strip() or "input_audio"
    tag = re.sub(r"\s+", "_", tag)
    tag = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", tag).strip("_")
    if not tag:
        tag = "input_audio"
    if (
        media_file
        and media_file != _MEDIA_SENTINEL
        and media_file not in _OLD_MEDIA_SENTINELS
    ):
        base = os.path.splitext(os.path.basename(str(media_file)))[0]
        base = re.sub(r"\s+", "_", base)
        base = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", base).strip("_")
        if base and tag == "input_audio":
            tag = base
    return tag


# ============================================================================
# 结果缓存：同一模型 + 同一音频 + 同一维度修复模式，不重复跑 Mel-Band RoFormer。
# ============================================================================

_SEPARATOR_RESULT_CACHE = {}
_SEPARATOR_RESULT_CACHE_ORDER = []
_SEPARATOR_RESULT_CACHE_MAX = 2

# V14：节点级最后成功输出缓存。
# 场景：本节点第一次正常拿到外部 AUDIO 并完成分离后，下游“显示/刷新波形”等 UI 行为可能会触发第二次 prompt，
# 这次 prompt 可能只包含本节点或下游节点，导致上游 AUDIO 没有再次传入。此时不应该报“没有收到输入”，
# 而应该复用本节点上一次成功输出。
_SEPARATOR_LAST_OUTPUT_CACHE = {}
_SEPARATOR_LAST_OUTPUT_ORDER = []
_SEPARATOR_LAST_OUTPUT_MAX = 16


def _safe_file_signature(media_file):
    """返回文件输入的稳定签名；文件没变就不重新计算。"""
    try:
        path = _resolve_input_media_file(media_file)
        if not path:
            return None
        st = os.stat(path)
        return ("file", os.path.abspath(path), int(st.st_size), int(st.st_mtime_ns))
    except Exception:
        return ("file", str(media_file))


def _hash_tensor_for_cache(tensor):
    """对 AUDIO waveform 做内容哈希，避免同长度但内容改变时误用缓存。"""
    if not isinstance(tensor, torch.Tensor):
        tensor = torch.as_tensor(tensor)
    t = tensor.detach().contiguous().cpu()
    h = hashlib.blake2b(digest_size=16)
    h.update(str(tuple(t.shape)).encode("utf-8"))
    h.update(str(t.dtype).encode("utf-8"))
    # numpy().tobytes() 对几分钟音频也远低于模型推理耗时。
    h.update(t.numpy().tobytes())
    return h.hexdigest()


def _audio_signature_for_cache(audio, *, fallback_source=None):
    """返回音频对象签名。AUDIO 用内容 hash；VIDEO/路径对象尽量先解析出音轨。"""
    normalized = _normalize_comfy_audio(audio)
    if normalized is None and audio is not None:
        normalized = _load_audio_from_video_like(audio)
    if normalized is None:
        return ("unknown", str(type(audio)), str(fallback_source))
    wf = normalized.get("waveform")
    sr = int(normalized.get("sample_rate", 0))
    return ("audio", sr, _hash_tensor_for_cache(wf))


def _clone_audio_for_cache(audio):
    if not isinstance(audio, dict):
        return audio
    out = {}
    for k, v in audio.items():
        if isinstance(v, torch.Tensor):
            out[k] = v.detach().cpu().clone()
        else:
            out[k] = v
    return out


def _clone_cached_result(result):
    vocals, instruments, duration = result
    return _clone_audio_for_cache(vocals), _clone_audio_for_cache(instruments), duration


def _cache_get(key):
    cached = _SEPARATOR_RESULT_CACHE.get(key)
    if cached is None:
        return None
    try:
        _SEPARATOR_RESULT_CACHE_ORDER.remove(key)
    except ValueError:
        pass
    _SEPARATOR_RESULT_CACHE_ORDER.append(key)
    return _clone_cached_result(cached)


def _cache_put(key, vocals, instruments, duration):
    _SEPARATOR_RESULT_CACHE[key] = (
        _clone_audio_for_cache(vocals),
        _clone_audio_for_cache(instruments),
        float(duration),
    )
    try:
        _SEPARATOR_RESULT_CACHE_ORDER.remove(key)
    except ValueError:
        pass
    _SEPARATOR_RESULT_CACHE_ORDER.append(key)
    while len(_SEPARATOR_RESULT_CACHE_ORDER) > _SEPARATOR_RESULT_CACHE_MAX:
        old_key = _SEPARATOR_RESULT_CACHE_ORDER.pop(0)
        _SEPARATOR_RESULT_CACHE.pop(old_key, None)


def _make_last_output_key(owner, kwargs):
    """为节点级最后输出缓存生成 key。优先使用 ComfyUI 传入的 UNIQUE_ID。"""
    unique_id = _pick_input_value(kwargs, None, "unique_id", "UNIQUE_ID", default=None)
    if unique_id not in (None, ""):
        return f"node:{unique_id}"
    # 兜底：同一个 Python 节点对象在同次会话内通常稳定。
    return f"obj:{id(owner)}"


def _last_output_get(key):
    cached = _SEPARATOR_LAST_OUTPUT_CACHE.get(key)
    if cached is None:
        return None
    try:
        _SEPARATOR_LAST_OUTPUT_ORDER.remove(key)
    except ValueError:
        pass
    _SEPARATOR_LAST_OUTPUT_ORDER.append(key)
    (
        vocals,
        instruments,
        duration,
        tag_text,
        source_desc,
        model_name,
        compatibility_mode,
    ) = cached
    return (
        _clone_audio_for_cache(vocals),
        _clone_audio_for_cache(instruments),
        float(duration),
        tag_text,
        source_desc,
        model_name,
        compatibility_mode,
    )


def _last_output_put(
    key,
    vocals,
    instruments,
    duration,
    tag_text,
    source_desc,
    model_name,
    compatibility_mode,
):
    _SEPARATOR_LAST_OUTPUT_CACHE[key] = (
        _clone_audio_for_cache(vocals),
        _clone_audio_for_cache(instruments),
        float(duration),
        str(tag_text),
        str(source_desc),
        str(model_name),
        str(compatibility_mode),
    )
    try:
        _SEPARATOR_LAST_OUTPUT_ORDER.remove(key)
    except ValueError:
        pass
    _SEPARATOR_LAST_OUTPUT_ORDER.append(key)
    while len(_SEPARATOR_LAST_OUTPUT_ORDER) > _SEPARATOR_LAST_OUTPUT_MAX:
        old_key = _SEPARATOR_LAST_OUTPUT_ORDER.pop(0)
        _SEPARATOR_LAST_OUTPUT_CACHE.pop(old_key, None)


def _build_debug_text(
    prefix, model_name, source_desc, compatibility_mode, duration, vocals, instruments
):
    return (
        f"{prefix}\n"
        f"模型：{model_name}\n"
        f"来源：{source_desc}\n"
        f"兼容模式：{compatibility_mode}\n"
        f"时长：{duration:.3f}s\n"
        f"人声：{tuple(vocals['waveform'].shape)}，采样率 {vocals['sample_rate']}Hz\n"
        f"背景声：{tuple(instruments['waveform'].shape)}，采样率 {instruments['sample_rate']}Hz"
    )


def _model_config():
    """原版 Mel-Band RoFormer 配置。"""
    return {
        "dim": 384,
        "depth": 6,
        "stereo": True,
        "num_stems": 1,
        "time_transformer_depth": 1,
        "freq_transformer_depth": 1,
        "num_bands": 60,
        "dim_head": 64,
        "heads": 8,
        "attn_dropout": 0,
        "ff_dropout": 0,
        "flash_attn": True,
        "dim_freqs_in": 1025,
        "sample_rate": 44100,
        "stft_n_fft": 2048,
        "stft_hop_length": 441,
        "stft_win_length": 2048,
        "stft_normalized": False,
        "mask_estimator_depth": 2,
        "multi_stft_resolution_loss_weight": 1.0,
        "multi_stft_resolutions_window_sizes": (4096, 2048, 1024, 512, 256),
        "multi_stft_hop_size": 147,
        "multi_stft_normalized": False,
    }


def _load_melband_model(model_name, device):
    """按原版结构加载 MelBandRoformer 模型。"""
    cache_key = (model_name, str(device))
    cached = _cached_models.get(cache_key)
    if cached is not None:
        cached.to(device)
        cached.eval()
        return cached

    model_path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
    model = MelBandRoformer(**_model_config()).eval()
    state_dict = load_torch_file(model_path)
    model.load_state_dict(state_dict, strict=True)
    model.to(device)
    model.eval()
    _cached_models.clear()  # 防止多模型长期占显存/内存；这里只缓存最近一个。
    _cached_models[cache_key] = model
    return model


def _get_windowing_array(window_size, fade_size, device):
    fadein = torch.linspace(0, 1, fade_size, device=device)
    fadeout = torch.linspace(1, 0, fade_size, device=device)
    window = torch.ones(window_size, device=device)
    window[-fade_size:] *= fadeout
    window[:fade_size] *= fadein
    return window


def _normalize_comfy_audio(audio):
    """统一为 ComfyUI AUDIO: {'waveform': [B,C,N], 'sample_rate': int}。"""
    if not isinstance(audio, dict):
        return None
    if "waveform" not in audio or "sample_rate" not in audio:
        return None

    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform)

    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    elif waveform.ndim > 3:
        waveform = waveform.reshape(-1, waveform.shape[-2], waveform.shape[-1])

    return {"waveform": waveform.contiguous(), "sample_rate": sample_rate}


def _load_audio_from_video_like(video_obj):
    """从 ComfyUI VIDEO / VideoFromFile / 视频路径对象读取音轨。"""
    # 1. VIDEO 组件对象：优先直接取 audio。
    if hasattr(video_obj, "get_components"):
        try:
            components = video_obj.get_components()
            audio = getattr(components, "audio", None)
            if audio is None and isinstance(components, dict):
                audio = components.get("audio")
            audio = _normalize_comfy_audio(audio)
            if audio is not None:
                return audio
        except Exception:
            pass

    # 2. VideoFromFile：通常可提供 stream source。
    stream_source = None
    if hasattr(video_obj, "get_stream_source"):
        try:
            stream_source = video_obj.get_stream_source()
        except Exception:
            stream_source = None

    # 3. 常见路径属性。
    if stream_source is None:
        for name in (
            "path",
            "filepath",
            "file_path",
            "filename",
            "video_path",
            "source",
            "src",
            "loaded_file",
            "full_path",
            "abs_path",
        ):
            try:
                value = getattr(video_obj, name, None)
                if callable(value):
                    value = value()
                if value:
                    stream_source = value
                    break
            except Exception:
                pass

    # 4. 输入本身就是路径。
    if stream_source is None and isinstance(video_obj, (str, os.PathLike)):
        stream_source = os.fspath(video_obj)

    if stream_source is None:
        return None

    if isinstance(stream_source, (str, os.PathLike)):
        raw_path = os.fspath(stream_source)
        resolved = raw_path
        try:
            if folder_paths.exists_annotated_filepath(raw_path):
                resolved = folder_paths.get_annotated_filepath(raw_path)
            elif not os.path.exists(raw_path):
                candidate = folder_paths.get_annotated_filepath(raw_path)
                if candidate and os.path.exists(candidate):
                    resolved = candidate
        except Exception:
            pass
        stream_source = resolved

    if hasattr(stream_source, "seek"):
        try:
            stream_source.seek(0)
        except Exception:
            pass

    try:
        from comfy_extras.nodes_audio import load as comfy_load_audio

        waveform, sample_rate = comfy_load_audio(stream_source)
        return _normalize_comfy_audio(
            {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
        )
    except Exception as e:
        raise RuntimeError(
            "输入是 VIDEO，但无法从视频中读取音轨。\n"
            "可能原因：视频没有音轨、视频文件路径不可访问，或 PyAV/音频依赖不可用。\n"
            f"当前输入类型: {type(video_obj).__name__}\n"
            f"读取源: {stream_source!r}\n"
            f"底层错误: {e}"
        )


def _extract_audio_from_media(media):
    audio = _normalize_comfy_audio(media)
    if audio is not None:
        return audio

    audio = _load_audio_from_video_like(media)
    if audio is not None:
        return audio

    raise RuntimeError(
        "输入口只兼容 AUDIO 或 VIDEO。\n"
        f"当前收到类型: {type(media).__name__}\n"
        "请连接音频对象，或连接 ComfyUI 的 VIDEO / VideoFromFile 输出。"
    )


def _run_model_chunk(
    model, input_tensor, compatibility_mode=_COMPAT_AUTO, debug_log=True
):
    """按兼容模式运行单个模型分块。

    自动兼容：先尝试原版 pack/unpack；若遇到 einops 维度错误，自动切换到显式维度修复。
    """
    mode = compatibility_mode if compatibility_mode in _COMPAT_VALUES else _COMPAT_AUTO

    def _call(actual_mode):
        try:
            setattr(model, "_gjj_compatibility_mode", actual_mode)
        except Exception:
            pass
        return model(input_tensor)

    if mode == _COMPAT_AUTO:
        try:
            return _call(_COMPAT_ORIGINAL)
        except Exception as exc:
            text = str(exc)
            is_dim_compat_error = (
                "rearrange-reduction pattern" in text
                or "Wrong shape" in text
                or "expected 4 dims" in text
                or "Received 3-dim" in text
                or "pack" in text.lower()
                or "unpack" in text.lower()
            )
            if not is_dim_compat_error:
                raise
            if debug_log:
                _log_warn(
                    "自动兼容：原版 pack/unpack 维度不匹配，已切换到“显式维度修复”。"
                )
            return _call(_COMPAT_EXPLICIT)

    return _call(mode)


def _process_with_real_melroformer(
    model, audio, device, debug_log=True, compatibility_mode=_COMPAT_AUTO
):
    """严格复刻原版 MelBandRoFormerSampler.process 的核心推理逻辑。

    注意：这里故意尽量不做额外后处理，避免和原版输出产生听感差异。
    """
    audio = _normalize_comfy_audio(audio)
    if audio is None:
        raise RuntimeError("收到的音频格式不正确，缺少 waveform / sample_rate。")

    audio_input = audio["waveform"]
    sample_rate = int(audio["sample_rate"])

    if audio_input.ndim != 3:
        raise RuntimeError(
            f"AUDIO waveform 维度异常: {tuple(audio_input.shape)}，期望 [B,C,N]。"
        )

    B, audio_channels, audio_length = audio_input.shape
    duration = int(audio_length) / max(sample_rate, 1)

    sr = 44100
    if debug_log:
        _log_model("开始音频分离")
        _log_model(
            f"输入音频 shape={tuple(audio_input.shape)}，采样率={sample_rate}Hz，时长={duration:.3f}s"
        )
        _log_model(f"计算设备={device}，目标采样率={sr}Hz")

    # 与原版一致：单声道复制成双声道。
    if audio_channels == 1:
        audio_input = audio_input.repeat(1, 2, 1)
        audio_channels = 2
        _log_warn("输入是单声道，已复制为双声道")
    elif audio_channels > 2:
        # 原版模型是 stereo=True，只能吃 2 声道。多声道保留前两路。
        audio_input = audio_input[:, :2, :]
        audio_channels = 2
        _log_warn(f"输入声道数超过 2，已保留前两路：shape={tuple(audio_input.shape)}")

    # 与原版一致：目标采样率固定 44100。
    if sample_rate != sr:
        _log_model(f"重采样：{sample_rate}Hz → {sr}Hz")
        TAF = _get_torchaudio_functional()
        audio_input = TAF.resample(audio_input, orig_freq=sample_rate, new_freq=sr)
        if debug_log:
            _log_model(f"重采样后 shape={tuple(audio_input.shape)}")
    elif debug_log:
        _log_model("输入已经是 44100Hz，跳过重采样")

    # 与原版一致：只处理第一个 batch，并把这个作为 instruments 残差的原音频。
    audio_input = original_audio = audio_input[0]

    C = 352800
    N = 2
    step = C // N
    fade_size = C // 10
    border = C - step

    # 原版这里使用的是重采样前的 audio_length 判断，保持一致。
    if audio_length > 2 * border and border > 0:
        audio_input = F.pad(audio_input, (border, border), mode="reflect")

    windowing_array = _get_windowing_array(C, fade_size, device)

    audio_input = audio_input.to(device)
    vocals = torch.zeros_like(audio_input, dtype=torch.float32).to(device)
    counter = torch.zeros_like(audio_input, dtype=torch.float32).to(device)

    total_length = audio_input.shape[1]
    num_chunks = (total_length + step - 1) // step
    if debug_log:
        _log_model(
            f"分块参数：总长度={total_length}，块大小={C}，步长={step}，淡入淡出={fade_size}，块数={num_chunks}"
        )
        _log_model(f"模型类={model.__class__.__name__}，兼容模式={compatibility_mode}")

    model.to(device)
    model.eval()

    comfy_pbar = ProgressBar(num_chunks)

    chunk_positions = range(0, total_length, step)
    if debug_log:
        try:
            from tqdm import tqdm as _tqdm

            chunk_positions = _tqdm(chunk_positions, desc="Processing chunks")
        except Exception:
            _log_model(f"开始处理分块：0/{num_chunks}")

    with torch.no_grad():
        for _chunk_index, i in enumerate(chunk_positions, start=1):
            part = audio_input[:, i : i + C]
            length = part.shape[-1]
            if length < C:
                if length > C // 2 + 1:
                    part = F.pad(input=part, pad=(0, C - length), mode="reflect")
                else:
                    part = F.pad(
                        input=part, pad=(0, C - length, 0, 0), mode="constant", value=0
                    )

            x = _run_model_chunk(
                model,
                part.unsqueeze(0),
                compatibility_mode=compatibility_mode,
                debug_log=debug_log,
            )[0]

            window = windowing_array.clone()
            if i == 0:
                window[:fade_size] = 1
            elif i + C >= total_length:
                window[-fade_size:] = 1

            vocals[..., i : i + length] += x[..., :length] * window[..., :length]
            counter[..., i : i + length] += window[..., :length]
            comfy_pbar.update(1)

    if debug_log:
        _log_model("分块推理完成")

    offload_device = mm.unet_offload_device()
    model.to(offload_device)

    # 与原版一致，不做 clamp / normalize / 降噪 / 限幅等额外处理。
    estimated_sources = vocals / counter

    if audio_length > 2 * border and border > 0:
        estimated_sources = estimated_sources[..., border:-border]

    vocals_out = {
        "waveform": estimated_sources.unsqueeze(0).cpu(),
        "sample_rate": sr,
    }
    instruments_out = {
        "waveform": (original_audio.to(device) - estimated_sources).unsqueeze(0).cpu(),
        "sample_rate": sr,
    }

    if debug_log:
        _log_model(
            f"输出：人声={tuple(vocals_out['waveform'].shape)}，背景声={tuple(instruments_out['waveform'].shape)}，采样率={sr}Hz"
        )
        _log_ok("音频分离完成")

    return vocals_out, instruments_out, duration


def _check_runtime_dependencies():
    """在执行开头集中检查运行时依赖，缺失时给出友好提示。"""
    _runtime_import(
        "numpy",
        package_name="numpy",
        description="该节点需要 numpy 生成 Mel 滤波器。ComfyUI 通常已自带该依赖。",
    )
    _runtime_import(
        "einops",
        package_name="einops",
        description="Mel-Band RoFormer 模型结构需要 einops 做张量维度重排。ComfyUI 通常已自带该依赖。",
    )
    _runtime_import(
        "rotary_embedding_torch",
        package_name="rotary-embedding-torch",
        description="Mel-Band RoFormer 模型结构需要 rotary_embedding_torch。",
    )
    _runtime_import(
        "torchaudio.functional",
        package_name="torchaudio",
        description="该节点需要 torchaudio.functional 对输入音频重采样到 44100Hz。ComfyUI 音频节点通常已安装 torchaudio。",
    )


def _pick_input_value(kwargs, current, *names, default=None):
    """兼容旧参数名和中文原生显示名。

    ComfyUI 原生左侧标签实际来自 INPUT_TYPES 的 key，
    不是所有版本都会用 display_name 覆盖。
    所以本节点把 key 改成“emoji + 中文”，再在执行时映射回内部变量。

    注意：中文 key 会进入 **kwargs；旧英文 key 会进入命名参数。
    因此必须优先读取 kwargs，再回退到命名参数默认值。
    """
    for name in names:
        if name in kwargs and kwargs[name] is not None:
            return kwargs[name]
    if current is not None:
        return current
    return default


class GJJ_AudioSeparator:
    """GJJ · 🎵 音频/视频音轨分离器（Mel-Band RoFormer 原版流程）"""

    DESCRIPTION = DESCRIPTION  # 引用模块级别的动态 DESCRIPTION

    GJJ_HELP = {
        "title": "GJJ · 🎵 音频/视频音轨分离器",
        "version": "V14",
        "author": "GJJ Custom Nodes Team",
        "description": (
            "使用 Mel-Band RoFormer 模型进行高质量人声/背景音分离，支持外部音频输入和节点内文件加载"
            if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
            else (_ENV_REPORT["warning_message"] if _ENV_REPORT is not None else _generate_warning_message(NODE_DISPLAY_NAME, dependencies_available=_DEPENDENCIES_AVAILABLE, models_available=_MODELS_AVAILABLE, missing_dependencies=_MISSING_DEPENDENCIES, missing_models=_MISSING_MODELS))
        ),
        "warning_message": _ENV_REPORT["warning_message"] if _ENV_REPORT is not None and not _ENV_REPORT.get("available", True) else "",
        "notice": _ENV_REPORT["warning_message"] if _ENV_REPORT is not None and not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if _ENV_REPORT is not None else "",
        "copy_text": _ENV_REPORT["copy_text"] if _ENV_REPORT is not None else "",
        "copy_label": _ENV_REPORT["copy_label"] if _ENV_REPORT is not None else "",
        "model_download_url": MODEL_DOWNLOAD_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "missing_models": _MISSING_MODELS,
        "models": [
            {
                "label": "MelBandRoformer 模型",
                "value": "📁models/diffusion_models/MelBandRoformer_fp16.safetensors",
                "tooltip": "Mel-Band RoFormer 人声分离模型。请放到 models/diffusion_models/MelBandRoformer_fp16.safetensors；下载地址见帮助信息中的统一网盘链接。",
            },
        ],
        "dependencies": [
            "numpy（数值计算，生成 Mel 滤波器）",
            "torchaudio（音频重采样到 44100Hz）",
            "rotary-embedding-torch（模型结构需要）",
            "einops（张量维度重排）",
        ],
        "features": [
            {
                "name": "人声/背景音分离",
                "description": "使用 Mel-Band RoFormer 模型进行高质量音频分离",
            },
            {
                "name": "多输入支持",
                "description": "支持外部 AUDIO 输入，也支持节点内直接加载音视频文件",
            },
            {
                "name": "视频音轨提取",
                "description": "自动从视频文件中提取音轨进行分离",
            },
            {
                "name": "批量处理友好",
                "description": "输出人声、背景声、时长和标签，便于后续处理",
            },
            {
                "name": "维度兼容模式",
                "description": "支持自动兼容、原版 pack/unpack、显式维度修复三种模式",
            },
        ],
        "inputs": {
            "audio": {
                "type": "AUDIO,VIDEO,*",
                "required": False,
                "description": "外部连接的音频/视频对象，优先级高于内部文件选择",
            },
            "model_name": {
                "type": "COMBO",
                "required": True,
                "description": "选择 MelBandRoformer 模型",
            },
            "media_file": {
                "type": "COMBO",
                "required": False,
                "description": "节点内音频/视频文件选择器；视频会自动只提取音频",
            },
            "audio_tag": {
                "type": "STRING",
                "required": False,
                "default": "input_audio",
                "description": "音频标签/别名，用于日志、UI 文本和 STRING 输出",
            },
            "compatibility_mode": {
                "type": "COMBO",
                "required": False,
                "default": "显式维度修复",
                "description": "维度修复模式，解决 einops pack/unpack 维度问题",
            },
        },
        "outputs": {
            "人声": {
                "type": "AUDIO",
                "description": "分离出的人声音频",
            },
            "背景声": {
                "type": "AUDIO",
                "description": "分离出的背景声/伴奏/乐器音频",
            },
            "音频时长": {
                "type": "FLOAT",
                "description": "输入音频或视频音轨的原始时长，单位秒",
            },
            "音频标签": {
                "type": "STRING",
                "description": "音频标签字符串，用于识别音频来源",
            },
        },
        "usage_examples": [
            {
                "title": "简单人声分离",
                "description": "加载音频文件，分离人声和背景声",
                "workflow": "[Audio File] → [GJJ AudioSeparator] → [Audio Preview]",
            },
            {
                "title": "视频音轨分离",
                "description": "从视频中提取音轨并分离人声",
                "workflow": "[Video File] → [GJJ AudioSeparator] → [Audio Preview]",
            },
            {
                "title": "批量处理",
                "description": "配合批量图片加载器处理多个音频文件",
                "workflow": "[Batch Loader] → [GJJ AudioSeparator] → [Batch Processor]",
            },
        ],
        "technical_notes": [
            "基于原版 Mel-Band RoFormer 推理流程",
            "音频自动重采样到 44100Hz",
            "支持 mono 和 stereo 音频",
            "包含结果缓存机制，避免重复计算",
        ],
        "troubleshooting": [
            {
                "problem": "未找到 MelBandRoformer 模型",
                "solution": "请将模型放到 ComfyUI/models/diffusion_models/ 目录下",
            },
            {
                "name": "einops pack/unpack 维度错误",
                "solution": "尝试切换到「显式维度修复」模式",
            },
            {
                "name": "音频输入为空",
                "solution": "检查外部连接或选择节点内音视频文件",
            },
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        models = _scan_melband_models()
        media_files = _scan_input_media_files()
        return {
            "required": {
                "📦 模型选择": (
                    models,
                    {
                        "display_name": "📦 模型选择",
                        "tooltip": "选择 MelBandRoformer 模型。模型请放在 ComfyUI/models/diffusion_models/。本节点已把加载音频、格式转换、音频打标和人声/背景声分离合并到一个节点里。",
                        "default": models[0] if models else "",
                    },
                ),
            },
            "optional": {
                "audio": (
                    "*",
                    {
                        "display_name": "🎵 外部音频",
                        "tooltip": "唯一左侧输入口。优先接 AUDIO；也兼容 VIDEO / VideoFromFile，接视频时自动提取视频音轨。有外接音频/视频时，优先使用外接输入，并忽略下面的音视频文件列表。内部参数名固定为 audio。",
                    },
                ),
                "📁 音视频文件": (
                    media_files,
                    {
                        "default": media_files[0] if media_files else _MEDIA_SENTINEL,
                        "display_name": "📁 音视频文件",
                        "tooltip": "没有外接音频时才使用这里选择的本地音频/视频文件。顶部“📁 打开音视频”可从电脑磁盘选择并上传到 ComfyUI/input/；视频只读取音轨。有外接音频时，列表会自动回到“外接音频优先”。",
                    },
                ),
                "🏷️ 音频标签": (
                    "STRING",
                    {
                        "default": "input_audio",
                        "multiline": False,
                        "display_name": "🏷️ 音频标签",
                        "tooltip": "音频标签/别名，用于日志、UI 文本和 STRING 输出。留空自动使用 input_audio；从文件加载且保持默认值时，会自动用文件名作为标签。",
                    },
                ),
                "🛠️ 维度修复模式": (
                    _COMPAT_VALUES,
                    {
                        "default": _COMPAT_EXPLICIT,
                        "display_name": "🛠️ 维度修复模式",
                        "tooltip": "维度修复模式。默认使用“显式维度修复”，可避免部分 einops 环境下 pack/unpack 丢维度导致的报错；可在顶部 🛠️ 按钮切换。",
                    },
                ),
                "🧾 日志输出": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🧾 日志输出",
                        "tooltip": "控制台日志开关。默认关闭；开启后输出模型加载、音频读取、重采样、分块推理等详细中文日志。可在顶部 🧾 按钮切换。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("AUDIO", "AUDIO", "FLOAT", "STRING")
    RETURN_NAMES = ("人声", "背景声", "音频时长", "音频标签")
    OUTPUT_TOOLTIPS = (
        "分离出的人声音频。",
        "分离出的背景声/伴奏/乐器音频。",
        "输入音频或视频音轨的原始时长，单位秒。",
        "音频标签字符串，可用于后续节点识别当前音频来源。",
    )
    FUNCTION = "execute"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        model_name = _pick_input_value(
            kwargs, None, "📦 模型选择", "model_name", default=""
        )

        # V13 关键修复：不要再让 audio 作为命名参数被函数签名提前消费。
        # ComfyUI 执行栈是 f(**inputs)，使用纯 **kwargs 后，audio / 中文 key / 旧 key 都能在这里被统一读取。
        media = _pick_input_value(
            kwargs,
            None,
            "audio",
            "media",
            "🎵 外部音频",
            "🎵 输入音频 / 视频",
            "🎵 输入音视频",
            "输入音视频",
            "输入音频 / 视频",
            "外部音频",
            default=None,
        )
        media_file = _pick_input_value(
            kwargs, None, "📁 音视频文件", "media_file", default=_MEDIA_SENTINEL
        )
        audio_tag = _pick_input_value(
            kwargs, None, "🏷️ 音频标签", "audio_tag", default="input_audio"
        )
        compatibility_mode = _pick_input_value(
            kwargs,
            None,
            "🛠️ 维度修复模式",
            "compatibility_mode",
            default=_COMPAT_EXPLICIT,
        )
        force_rerun = bool(
            _pick_input_value(kwargs, False, "force_rerun", default=False)
        )
        debug_nonce = _pick_input_value(kwargs, "0", "debug_nonce", default="0")

        if force_rerun:
            return float("nan")

        try:
            if media is not None:
                source_sig = _audio_signature_for_cache(
                    media, fallback_source="external"
                )
            else:
                source_sig = _safe_file_signature(media_file)
        except Exception as e:
            source_sig = ("sig_error", str(e), str(media_file))

        return f"model={model_name}|source={source_sig}|tag={audio_tag}|mode={compatibility_mode}|nonce={debug_nonce}"

    def execute(self, **kwargs):
        model_name = _pick_input_value(
            kwargs, None, "📦 模型选择", "model_name", default=""
        )
        media_input = _pick_input_value(
            kwargs,
            None,
            "audio",
            "media",
            "🎵 外部音频",
            "🎵 输入音频 / 视频",
            "🎵 输入音视频",
            "输入音视频",
            "输入音频 / 视频",
            "外部音频",
            default=None,
        )
        media_file = _pick_input_value(
            kwargs, None, "📁 音视频文件", "media_file", default=_MEDIA_SENTINEL
        )
        audio_tag = _pick_input_value(
            kwargs, None, "🏷️ 音频标签", "audio_tag", default="input_audio"
        )
        compatibility_mode = _pick_input_value(
            kwargs,
            None,
            "🛠️ 维度修复模式",
            "compatibility_mode",
            default=_COMPAT_EXPLICIT,
        )
        debug_log = bool(
            _pick_input_value(kwargs, False, "🧾 日志输出", "debug_log", default=False)
        )
        last_output_key = _make_last_output_key(self, kwargs)

        # 在 execute 开头进行运行时依赖检查；启动 ComfyUI 时不会检查这些依赖。
        unique_id = kwargs.get("unique_id")
        try:
            _check_runtime_dependencies()
        except Exception as e:
            report = getattr(e, "gjj_report", None) or build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[
                    {
                        "module_name": spec["module_name"],
                        "package_name": spec["package_name"],
                        "display_name": spec["module_name"],
                        "description": spec["description"],
                    }
                    for spec in REQUIRED_DEPENDENCIES
                ],
                install_packages=[spec["package_name"] for spec in REQUIRED_DEPENDENCIES],
                original_error=str(e),
            )
            try:
                from server import PromptServer

                PromptServer.instance.send_sync(
                    "gjj_audio_separator_error",
                    {
                        "node": str(unique_id) if unique_id else None,
                        "warning_message": report.get("warning_message", ""),
                        "panel_message": report.get("panel_message", ""),
                        "help_message": report.get("help_message", ""),
                        "install_command": report.get("install_cmd", ""),
                        "copy_text": report.get("copy_text", ""),
                        "copy_label": report.get("copy_label", ""),
                        "model_download_url": MODEL_DOWNLOAD_URL,
                        "missing_dependencies": report.get("missing_dependencies", []),
                        "missing_models": report.get("missing_models", []),
                    },
                )
            except Exception:
                pass
            _log_error("运行时依赖缺失，详情已显示在节点面板。")
            raise RuntimeError(report.get("warning_message") or "运行时依赖缺失。") from e

        if model_name == "[未找到 MelBandRoformer 模型]":
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[REQUIRED_MODEL],
                install_packages=[],
                original_error="",
                model_download_url=MODEL_DOWNLOAD_URL,
            )
            try:
                from server import PromptServer

                PromptServer.instance.send_sync(
                    "gjj_audio_separator_error",
                    {
                        "node": str(unique_id) if unique_id else None,
                        "warning_message": report.get("warning_message", ""),
                        "panel_message": report.get("panel_message", ""),
                        "help_message": report.get("help_message", ""),
                        "install_command": "",
                        "copy_text": report.get("copy_text", ""),
                        "copy_label": report.get("copy_label", ""),
                        "model_download_url": MODEL_DOWNLOAD_URL,
                        "missing_dependencies": [],
                        "missing_models": report.get("missing_models", []),
                    },
                )
            except Exception:
                pass
            _log_error("模型缺失，详情已显示在节点面板。")
            raise RuntimeError(report.get("warning_message") or "未找到 MelBandRoformer 模型。") from None

        tag_text = _format_audio_tag(audio_tag, media_file)

        if debug_log:
            _log_model(
                f"调用节点：模型={model_name}，外接输入={type(media_input).__name__ if media_input is not None else '无'}，文件={media_file}，标签={tag_text}，兼容模式={compatibility_mode}"
            )

        try:
            if media_input is not None:
                audio_input = _extract_audio_from_media(media_input)
                source_desc = f"外接音频：{type(media_input).__name__}"
            else:
                audio_input = _load_audio_from_file(media_file)
                if audio_input is None:
                    last_cached = _last_output_get(last_output_key)
                    if last_cached is not None:
                        (
                            vocals,
                            instruments,
                            duration,
                            cached_tag,
                            cached_source,
                            cached_model,
                            cached_mode,
                        ) = last_cached
                        # V14：下游刷新/预览可能触发二次 prompt，但这次 prompt 没带上游 AUDIO。
                        # 这里复用本节点上一次成功输出，让下游拿到稳定音频，不再重复报错或重算。
                        _log_ok("二次请求未携带外部音频，已复用本节点上一次成功输出")
                        debug_text = _build_debug_text(
                            "GJJ 音频分离完成（二次请求复用上次输出）",
                            cached_model or model_name,
                            cached_source or "上一次成功输出",
                            cached_mode or compatibility_mode,
                            duration,
                            vocals,
                            instruments,
                        )
                        return {
                            "ui": {"text": [debug_text]},
                            "result": (
                                vocals,
                                instruments,
                                duration,
                                cached_tag or tag_text,
                            ),
                        }
                    raise RuntimeError(
                        "没有收到输入。请连接唯一输入口“外部音频”，或在 📁 音视频文件中选择 ComfyUI/input/ 目录下的音频/视频文件。"
                    )
                source_desc = f"本地文件：{media_file}"
        except Exception as e:
            _log_error(f"提取/加载音频失败：{e}")
            raise

        try:
            wf = audio_input.get("waveform") if isinstance(audio_input, dict) else None
            sr0 = (
                audio_input.get("sample_rate")
                if isinstance(audio_input, dict)
                else None
            )
            _log_model(
                f"已获取音轨：shape={tuple(wf.shape) if hasattr(wf, 'shape') else None}，采样率={sr0}Hz，设备={getattr(wf, 'device', None)}"
            )
        except Exception:
            pass

        # V11 缓存：音频内容、模型、兼容模式都没变时，直接返回上次结果。
        try:
            source_sig = _audio_signature_for_cache(
                audio_input, fallback_source=source_desc
            )
        except Exception as e:
            source_sig = ("sig_error", str(e), source_desc)
        cache_key = (str(model_name), str(compatibility_mode), source_sig)
        cached = _cache_get(cache_key)
        if cached is not None:
            vocals, instruments, duration = cached
            _log_ok("命中缓存：输入音频未改变，跳过模型推理")
            _last_output_put(
                last_output_key,
                vocals,
                instruments,
                duration,
                tag_text,
                source_desc,
                model_name,
                compatibility_mode,
            )
            debug_text = _build_debug_text(
                "GJJ 音频分离完成（缓存命中）",
                model_name,
                source_desc,
                compatibility_mode,
                duration,
                vocals,
                instruments,
            )
            return {
                "ui": {"text": [debug_text]},
                "result": (vocals, instruments, duration, tag_text),
            }

        device = mm.get_torch_device()
        _log_model(f"准备加载模型：{model_name}，目标设备={device}")
        try:
            model = _load_melband_model(model_name, device)
        except Exception as e:
            _log_error(f"模型加载失败：{model_name}，原因：{e}")
            raise
        _log_model(f"模型加载完成：{type(model).__name__}")
        try:
            vocals, instruments, duration = _process_with_real_melroformer(
                model,
                audio_input,
                device,
                debug_log=debug_log,
                compatibility_mode=compatibility_mode,
            )
        except Exception as e:
            _log_error(f"模型推理失败：{e}")
            raise
        _cache_put(cache_key, vocals, instruments, duration)
        _last_output_put(
            last_output_key,
            vocals,
            instruments,
            duration,
            tag_text,
            source_desc,
            model_name,
            compatibility_mode,
        )
        mm.soft_empty_cache()
        debug_text = _build_debug_text(
            "GJJ 音频分离完成",
            model_name,
            source_desc,
            compatibility_mode,
            duration,
            vocals,
            instruments,
        )
        return {
            "ui": {"text": [debug_text]},
            "result": (vocals, instruments, duration, tag_text),
        }


NODE_CLASS_MAPPINGS = {
    "GJJ_AudioSeparator": GJJ_AudioSeparator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_AudioSeparator": "🎵 音视频人声、背景音分离(Mel-Band RoFormer)",
}
