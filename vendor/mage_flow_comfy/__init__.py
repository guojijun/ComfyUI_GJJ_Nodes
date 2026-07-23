"""Bundled Mage-Flow ComfyUI compatibility runtime.

Derived from ComfyUI-Mage (GPL-3.0); see the adjacent LICENSE file.
The code is bundled so GJJ nodes do not depend on another custom-node install.
"""

from .native_support import apply

__all__ = ["apply"]
