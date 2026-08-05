"""GJJ 内置的 MiniMax H3 Spectrum 运行时。

移植自 ComfyUI-Spectrum-MiniMax-H3，按 GPL-3.0 许可分发。
实现文件保持独立，以便核对上游算法并避免依赖原插件安装。
"""

from .config import SpectrumH3Config
from .minimax_h3 import install_h3_wrapper, require_native_minimax_h3
from .runtime import SpectrumH3Runtime
from .sampling import install_sampler_wrappers

__all__ = [
    "SpectrumH3Config",
    "SpectrumH3Runtime",
    "install_h3_wrapper",
    "install_sampler_wrappers",
    "require_native_minimax_h3",
]
