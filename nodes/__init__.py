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

# 这些节点可能依赖额外库，比如 cv2、torchcodec 等。
# 缺依赖时允许跳过，不影响整个 GJJ 包加载。
OPTIONAL_NODE_MODULES = {
    "gjj_latentsync_node",
}


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


def _safe_import_node_module(module_name):
    """
    安全导入单个节点模块。

    如果某个节点模块缺依赖，例如：
        import cv2
        import torchcodec
        import mediapipe

    这里会捕获异常并跳过该模块，避免整个 GJJ 包加载失败。
    """
    try:
        return importlib.import_module("." + module_name, __name__)
    except Exception as exc:
        print("=" * 80)
        print(f"[GJJ] 跳过节点模块: {module_name}")
        print(f"[GJJ] 原因: {type(exc).__name__}: {exc}")
        print("[GJJ] 该模块中的节点不会注册，但其它 GJJ 节点会继续加载。")
        print("=" * 80)
        traceback.print_exc()
        return None


def _merge_node_module(module):
    """
    合并模块里的 NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS。
    """
    if module is None:
        return

    if hasattr(module, "NODE_CLASS_MAPPINGS"):
        NODE_CLASS_MAPPINGS.update(module.NODE_CLASS_MAPPINGS)

    if hasattr(module, "NODE_DISPLAY_NAME_MAPPINGS"):
        NODE_DISPLAY_NAME_MAPPINGS.update(module.NODE_DISPLAY_NAME_MAPPINGS)


# 自动导入当前 nodes 目录下的所有 .py 节点文件
for f in glob.glob(os.path.join(os.path.dirname(__file__), "*.py")):
    module_name = os.path.basename(f)[:-3]

    if module_name == "__init__":
        continue

    # 避免可选节点被这里导入一次，后面又导入一次
    if module_name in OPTIONAL_NODE_MODULES:
        continue

    module = _safe_import_node_module(module_name)
    _merge_node_module(module)


# 单独导入可选节点：LatentSync
# 缺 cv2 / 其它依赖时，只跳过 LatentSync，不影响整个 GJJ 包。
for module_name in OPTIONAL_NODE_MODULES:
    module = _safe_import_node_module(module_name)
    _merge_node_module(module)


# 统一处理显示名称和节点颜色
for node_key, node_cls in NODE_CLASS_MAPPINGS.items():
    raw_display_name = NODE_DISPLAY_NAME_MAPPINGS.get(node_key)

    if not raw_display_name:
        raw_display_name = (
            getattr(node_cls, "DISPLAY_NAME", None)
            or getattr(node_cls, "NAME", None)
            or node_key
        )

    is_backend_node = (
        str(node_key).startswith("guojijun_")
        or str(getattr(node_cls, "CATEGORY", "")).startswith("guojijun")
    )

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
