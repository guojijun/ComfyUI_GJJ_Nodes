import os
import importlib
import glob
import re
import traceback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
DISPLAY_NAME_PREFIX = "GJJ · "
DEFAULT_NODE_HEADER = "#1B252B"
DEFAULT_NODE_PANEL = "#141B1F"
DEFAULT_NODE_OUTLINE = "#3E4D54"


def _humanize_name(name):
    text = str(name or "").strip()
    text = re.sub(r"^GJJ[_\s:-]*", "", text)
    text = text.replace("_", " ")
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_display_name(name):
    text = str(name or "").strip()
    if not text:
        text = "Node"

    if re.fullmatch(r"[A-Za-z0-9_:-]+", text):
        text = _humanize_name(text)

    text = re.sub(r"^GJJ[\s·:/_-]*", "", text).strip()
    return f"{DISPLAY_NAME_PREFIX}{text or 'Node'}"


def _normalize_backend_display_name(name, node_key):
    text = str(name or "").strip()
    if not text:
        text = _humanize_name(node_key)

    text = re.sub(r"^GJJ[\s·:/_-]*", "", text).strip()
    text = re.sub(r"^guojijun[\s·:/_-]*", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"[（(]\s*内部引用\s*[）)]$", "", text).strip()
    return f"guojijun · {text or '内部节点'}（内部引用）"

for f in glob.glob(os.path.join(os.path.dirname(__file__), "*.py")):
    n = os.path.basename(f)[:-3]
    if n == "__init__":
        continue
    try:
        m = importlib.import_module("." + n, __name__)
    except Exception as exc:
        print(f"[GJJ] 跳过节点模块 {n}: {exc}")
        traceback.print_exc()
        continue
    if hasattr(m, "NODE_CLASS_MAPPINGS"):
        NODE_CLASS_MAPPINGS.update(m.NODE_CLASS_MAPPINGS)
    if hasattr(m, "NODE_DISPLAY_NAME_MAPPINGS"):
        NODE_DISPLAY_NAME_MAPPINGS.update(m.NODE_DISPLAY_NAME_MAPPINGS)

# 导入LatentSync节点
from ..nodes.gjj_latentsync_node import NODE_CLASS_MAPPINGS as LATENTSYNC_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as LATENTSYNC_NODE_DISPLAY_NAME_MAPPINGS

# 合并节点映射
NODE_CLASS_MAPPINGS.update(LATENTSYNC_NODE_CLASS_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(LATENTSYNC_NODE_DISPLAY_NAME_MAPPINGS)

for node_key, node_cls in NODE_CLASS_MAPPINGS.items():
    raw_display_name = NODE_DISPLAY_NAME_MAPPINGS.get(node_key)
    if not raw_display_name:
        raw_display_name = getattr(node_cls, "DISPLAY_NAME", None) or getattr(node_cls, "NAME", None) or node_key

    is_backend_node = str(node_key).startswith("guojijun_") or str(getattr(node_cls, "CATEGORY", "")).startswith("guojijun")
    normalized_display_name = (
        _normalize_backend_display_name(raw_display_name, node_key)
        if is_backend_node
        else _normalize_display_name(raw_display_name)
    )
    NODE_DISPLAY_NAME_MAPPINGS[node_key] = normalized_display_name

    if hasattr(node_cls, "DISPLAY_NAME"):
        node_cls.DISPLAY_NAME = normalized_display_name

    # 给整个 GJJ 包统一深色面板，避免单个节点自带亮色主题。
    setattr(node_cls, "NODE_COLOR", DEFAULT_NODE_HEADER)
    setattr(node_cls, "BACKGROUND_COLOR", DEFAULT_NODE_PANEL)
    setattr(node_cls, "COLOR", DEFAULT_NODE_HEADER)
    setattr(node_cls, "BGCOLOR", DEFAULT_NODE_PANEL)
    setattr(node_cls, "BOX_COLOR", DEFAULT_NODE_OUTLINE)
