#!/usr/bin/env python3
"""
GJJ Node Documentation Generator v3
Reads JS (frontend) + PY (backend) source files and generates detailed markdown docs.
Output: SKILL/<category>/<NodeName>.md
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

BASE_DIR = Path(__file__).parent
JS_DIR = BASE_DIR / "js"
NODES_DIR = BASE_DIR / "nodes"
SKILL_DIR = BASE_DIR / "SKILL"

# Files that are infrastructure/utilities, not standalone nodes
SKIP_JS = {
    "gjj_utils.js",
    "gjj_shortcuts.js",
    "gjj_node_theme.js",
    "gjj_type_colors.js",
    "gjj_search_utils.js",
    "gjj_batch_image_search_hints.js",
    "gjj_help_button_manager.js",
    "gjj_set_get_node.js",
    "gjj_node_standardizer.js",
    "gjj_ollama_models.js",
    "GJJ_ColorPicker.js",
    "GJJ_AnimeLineartRealConverter.js",
    "gjj_any_preview.js",
    "gjj_region_layer_tools.js",
    "gjj_points_editor.js",
    "gjj_prompt_relay.js",
}

SKIP_PY = {
    "__init__.py",
    "analyze_official_workflows.py",
    "analyze_video_workflows.py",
    "fix_insightface_bug.py",
    "gjj_batch_watermark_remover.js",
    # Runtime/infrastructure modules
    "gjj_face_detailer_modules.py",
    "gjj_face_detailer_runtime.py",
    "gjj_flashvsr_runtime.py",
    "gjj_rife_runtime.py",
    "gjj_sam3_runtime.py",
    "gjj_ultralytics_runtime.py",
    "gjj_cosyvoice3_runtime.py",
    "gjj_longcat_audiodit_loader.py",
    "gjj_longcat_audiodit_model_cache.py",
    "gjj_fish_audio_s2_loader.py",
    "gjj_fish_audio_s2_model_cache.py",
    "gjj_ltx23_multiref_runtime.py",
    "gjj_ollama_common.py",
    "gjj_ltx23_template_workflows.py",
    "gjj_ltx23_workflow_suite.py",
    "gjj_latentsync_node.py",
    "gjj_ltx_first_last_frame.py",
}

CATEGORY_MAP = {
    "GJJ": "general",
    "GJJ/图像": "image",
    "GJJ/视频": "video",
    "GJJ/音频": "audio",
    "GJJ/文字": "text",
    "GJJ/翻译": "translate",
    "GJJ/3D": "3d",
    "GJJ/工具": "utility",
    "GJJ/layer": "layer",
    "GJJ/sam3": "sam3",
    "GJJ/Image": "image",
    "GJJ/Video": "video",
    "GJJ/Audio": "audio",
    "GJJ/Text": "text",
}


# ============================================================
# PYTHON PARSING
# ============================================================


def _clean_default(val: str) -> str:
    """Extract just the default value from a (type, default...) tuple."""
    # e.g.: ('STRING', {'default': 'hello'}) -> "hello"
    # e.g.: ('INT', {'default': 5, 'min': 1}) -> 5
    # e.g.: ('FLOAT', {'default': 0.5, }) -> 0.5
    # First try: if there's a dict with 'default'
    m = re.search(r"\{[^}]*['\"](?:default|DEFAULT)['\"]\s*:\s*([^,}]+)", val)
    if m:
        return m.group(1).strip().strip("'\"")
    # If no dict, try simple second element
    parts = _split_params(val)
    if len(parts) >= 2:
        second = parts[1].strip()
        # If it's a dict, try to extract default from it
        m2 = re.search(r"['\"](?:default|DEFAULT)['\"]\s*:\s*([^,}]+)", second)
        if m2:
            return m2.group(1).strip().strip("'\"")
        return second.strip("'\"")
    return "-"


def _extract_py_class_body(src: str, class_name: str) -> str | None:
    """Extract the body of a class definition using indentation tracking."""
    # Find "class ClassName"
    pattern = rf"\bclass\s+{re.escape(class_name)}\s*[:(]"
    m = re.search(pattern, src)
    if not m:
        return None

    start = m.start()
    # Walk forward tracking indentation
    lines = src[start:].split("\n")
    # Find first line's indent
    body_lines = []
    in_dedent = False
    next_indent = None

    for i, line in enumerate(lines):
        stripped = line.strip()
        if i == 0:  # class def line
            body_lines.append(line)
            continue

        if not stripped or stripped.startswith("#"):
            body_lines.append(line)
            continue

        # Determine indentation based on context
        indent = len(line) - len(line.lstrip())
        if next_indent is None:
            if indent > 0:
                next_indent = indent
            else:
                continue

        if indent > 0 and indent < next_indent:
            # Variable reduced indent - could be method start
            if stripped.startswith("def ") or stripped.startswith("class "):
                in_dedent = True
            else:
                # Still in class body
                pass

        if indent == 0 and i > 0:
            # Top-level statement outside class
            break

        body_lines.append(line)

    return "\n".join(body_lines)


def extract_py_nodes(filepath: Path, content: str) -> list[dict]:
    """Extract all GJJ node class definitions from a Python file."""
    nodes = []

    # Find all classes by looking for class defs that have CATEGORY assignment
    class_names = re.findall(r"class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:", content)
    for class_name, _ in class_names:
        body = _extract_py_class_body(content, class_name)
        if not body or "CATEGORY" not in body:
            continue

        node = {
            "class_name": class_name,
            "file": filepath.name,
            "category": "",
            "function": "",
            "description": "",
            "display_name": "",
            "return_types": [],
            "return_names": [],
            "output_node": False,
            "inputs": [],
        }

        # Extract CATEGORY
        m = re.search(r'CATEGORY\s*=\s*"([^"]+)"', body)
        if m:
            node["category"] = m.group(1)

        # Extract FUNCTION
        m = re.search(r'FUNCTION\s*=\s*"([^"]+)"', body)
        if m:
            node["function"] = m.group(1)

        # Extract DESCRIPTION (handle triple-quoted strings)
        m = re.search(r'DESCRIPTION\s*=\s*"""([^"]*?)"""', body, re.DOTALL)
        if not m:
            m = re.search(r"DESCRIPTION\s*=\s*'''([^']*?)'''", body, re.DOTALL)
        if not m:
            m = re.search(r'DESCRIPTION\s*=\s*"([^"]+)"', body)
        if m:
            desc = m.group(1).strip()
            # Take first line or first sentence
            first_line = desc.split("\n")[0].strip()
            if first_line and len(first_line) < 200:
                node["description"] = first_line
            else:
                node["description"] = desc[:200]

        # Extract RETURN_TYPES
        m = re.search(r"RETURN_TYPES\s*=\s*\(([^)]+)\)", body, re.DOTALL)
        if m:
            node["return_types"] = [
                t.strip().strip("'\"") for t in m.group(1).split(",") if t.strip()
            ]

        # Extract RETURN_NAMES
        m = re.search(r"RETURN_NAMES\s*=\s*\(([^)]+)\)", body, re.DOTALL)
        if m:
            node["return_names"] = [
                n.strip().strip("'\"") for n in m.group(1).split(",") if n.strip()
            ]

        # OUTPUT_NODE
        node["output_node"] = bool(re.search(r"OUTPUT_NODE\s*=\s*True", body))

        # Parse INPUT_TYPES - required
        req_m = re.search(
            r'"required"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', body, re.DOTALL
        )
        if req_m:
            node["inputs"].extend(_parse_input_pairs(req_m.group(1), required=True))

        # Parse optional inputs
        opt_m = re.search(
            r'"optional"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', body, re.DOTALL
        )
        if opt_m:
            node["inputs"].extend(_parse_input_pairs(opt_m.group(1), required=False))

        # Check for dynamic optional (Flexible/AutoIncrement)
        if not opt_m and re.search(r'"optional"\s*:\s*\w+\(', body):
            node["inputs"].append(
                {
                    "name": "*动态输入*",
                    "type": "Dynamic",
                    "default": "-",
                    "required": False,
                    "note": "支持动态数量输入插槽",
                }
            )

        nodes.append(node)

    return nodes


def _parse_input_pairs(body: str, required: bool) -> list[dict]:
    """Parse key-value pairs from INPUT_TYPES dict body, cleanly."""
    result = []
    # Match "name": (TYPE, {...})
    pairs = re.findall(r'"(\w+)"\s*:\s*\(([^)]+(?:\([^)]*\)[^)]*)*)\)', body, re.DOTALL)
    for pname, pdef in pairs:
        pdef = pdef.strip()
        parts = _split_params(pdef)
        ptype = parts[0].strip().strip("'\"") if parts else "?"
        default = _clean_default(pdef) if len(parts) > 1 else "-"
        result.append(
            {
                "name": pname,
                "type": ptype,
                "default": default,
                "required": required,
            }
        )
    return result


def _split_params(s: str) -> list[str]:
    """Split comma-separated params, respecting nested parens/braces/brackets."""
    parts = []
    depth = 0
    current = []
    for ch in s:
        if ch in "({[":
            depth += 1
        elif ch in ")}]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current).strip())
    return parts


# ============================================================
# JAVASCRIPT PARSING
# ============================================================


def extract_js_info(filepath: Path, content: str) -> dict | None:
    """Extract frontend extension info from a JS file."""
    info = {
        "file": filepath.name,
        "targets": [],
        "extension_name": "",
        "hooks": [],
        "has_dom_widget": False,
        "has_audio_preview": False,
        "has_preview_image": False,
        "setup_runs": False,
        "summary": "",
    }

    # Pattern 1: TARGET_NODES = new Set([...])
    m = re.search(
        r"TARGET_NODES\s*=\s*new\s+Set\s*\(\[([^\]]*)\]\)", content, re.DOTALL
    )
    if m:
        info["targets"] = re.findall(r'"(\w+)"', m.group(1))

    # Pattern 2: const NODE_TYPE = "..."
    if not info["targets"]:
        m = re.search(r'(?:const|let|var)\s+NODE_TYPE\s*=\s*["\'](\w+)["\']', content)
        if m:
            info["targets"] = [m.group(1)]

    # Pattern 3: const NODE_NAME = "..."
    if not info["targets"]:
        m = re.search(r'(?:const|let|var)\s+NODE_NAME\s*=\s*["\'](\w+)["\']', content)
        if m:
            info["targets"] = [m.group(1)]

    # Pattern 4: const TARGET_NODE = "..."
    if not info["targets"]:
        m = re.search(r"TARGET_NODE\s*=\s*[\"'](\w+)[\"']", content)
        if m:
            info["targets"] = [m.group(1)]

    # Pattern 5: const NODE_CLASS = "..."
    if not info["targets"]:
        m = re.search(r"NODE_CLASS\s*=\s*[\"'](\w+)[\"']", content)
        if m:
            info["targets"] = [m.group(1)]

    # Pattern 6: const TARGET_CLASS = "..."
    if not info["targets"]:
        m = re.search(r"TARGET_CLASS\s*=\s*[\"'](\w+)[\"']", content)
        if m:
            info["targets"] = [m.group(1)]

    if not info["targets"]:
        return None

    # Extension name
    m = re.search(
        r"app\.registerExtension\s*\(\s*\{[^}]*name\s*:\s*['\"](.+?)['\"]",
        content,
        re.DOTALL,
    )
    if m:
        info["extension_name"] = m.group(1)

    # Hooks
    for hook in [
        "beforeRegisterNodeDef",
        "nodeCreated",
        "onConnectionsChange",
        "onConfigure",
        "setup",
        "onExecuted",
        "onDrawBackground",
        "getCustomWidgets",
        "onNodeCreated",
    ]:
        if re.search(rf"\b{re.escape(hook)}\s*[\(:]", content):
            info["hooks"].append(hook)

    # Features
    info["has_dom_widget"] = "addDOMWidget" in content or "addWidget" in content
    info["has_audio_preview"] = "AudioWidget" in content
    info["has_preview_image"] = "preview_image" in content
    info["setup_runs"] = "setup(" in content or "refreshNode" in content

    info["summary"] = _summarize_js(content, info)

    return info


def _summarize_js(content: str, info: dict) -> str:
    """Generate a human-readable summary of what the JS frontend does."""
    features = []

    if info["has_dom_widget"]:
        if "iframe" in content.lower():
            features.append("使用 iframe 嵌入自定义 UI 面板")
        elif "custom_widget" in content.lower():
            features.append("注入自定义 UI 控件(Custom Widget)")
        else:
            features.append("提供 DOM Widget 自定义控制面板")

    if info["has_preview_image"]:
        features.append("在节点内显示预览图像")

    if info["has_audio_preview"]:
        features.append("内置音频播放器")

    if "onConnectionsChange" in info["hooks"]:
        features.append("监听连线变化自动调整输入插槽")

    if "onDrawBackground" in info["hooks"]:
        features.append("自定义节点背景绘制(批量/对比预览)")

    if info["setup_runs"] and info["has_dom_widget"]:
        features.append("加载工作流时初始化节点 UI 状态")

    # Check for dynamic input management
    if "addInput" in content or "removeInput" in content:
        features.append("自动管理动态输入/输出插槽")

    if not features:
        features.append("提供基础节点注册和类型颜色配置")

    return "；".join(features)


# ============================================================
# DOC GENERATION
# ============================================================


def generate_doc(
    class_name: str,
    py_nodes: list[dict],
    js_info: dict | None,
) -> str:
    """Generate a comprehensive markdown document for a node."""
    lines = [f"# {class_name}", ""]

    # ===== OVERVIEW =====
    lines.append("## 📋 概述")
    lines.append("")

    if py_nodes:
        desc = py_nodes[0].get("description", "")
        func = py_nodes[0].get("function", "")
        if desc:
            lines.append(desc)
        elif func:
            lines.append(f"**功能**: `{func}`")
        lines.append("")
    else:
        lines.append(f"GJJ {class_name} 节点")
        lines.append("")

    # ===== FILES =====
    lines.append("## 📁 文件映射")
    lines.append("")
    lines.append("| 层级 | 文件 | 说明 |")
    lines.append("|------|------|------|")
    if js_info:
        lines.append(f"| 🎨 前端 | `js/{js_info['file']}` | {js_info['summary']} |")
    if py_nodes:
        for n in py_nodes:
            lines.append(
                f"| 🔧 后端 | `nodes/{n['file']}` | `{n['class_name']}` 后端执行逻辑 |"
            )
    lines.append("")

    # ===== BACKEND =====
    if py_nodes:
        for node in py_nodes:
            lines.append("## 🔧 后端节点")
            lines.append("")

            # Metadata table
            lines.append("### 基础信息")
            lines.append("")
            lines.append("| 属性 | 值 |")
            lines.append("|------|-----|")
            lines.append(f"| **类名** | `{node['class_name']}` |")
            lines.append(f"| **CATEGORY** | `{node['category']}` |")
            lines.append(f"| **FUNCTION** | `{node['function']}` |")
            if node["output_node"]:
                lines.append("| **OUTPUT_NODE** | `True` |")
            lines.append("")

            # Inputs
            if node["inputs"]:
                lines.append("### 输入参数")
                lines.append("")
                lines.append("| 参数名 | 类型 | 默认值 | 必填 | 说明 |")
                lines.append("|--------|------|--------|------|------|")
                for inp in node["inputs"]:
                    default = str(inp.get("default", "-"))
                    lines.append(
                        f"| `{inp['name']}` | `{inp['type']}` | "
                        f"`{default}` | {'✓' if inp['required'] else ''} | |"
                    )
                lines.append("")

            # Outputs
            if node["return_types"]:
                lines.append("### 输出")
                lines.append("")
                lines.append("| 输出名 | 类型 | 说明 |")
                lines.append("|--------|------|------|")
                for i, rt in enumerate(node["return_types"]):
                    name = (
                        node["return_names"][i]
                        if i < len(node["return_names"])
                        else f"output_{i}"
                    )
                    lines.append(f"| {name} | `{rt}` | |")
                lines.append("")

    # ===== FRONTEND =====
    if js_info:
        lines.append("## 🎨 前端扩展")
        lines.append("")
        lines.append("### 注册信息")
        lines.append("")
        lines.append("| 属性 | 值 |")
        lines.append("|------|-----|")
        if js_info["extension_name"]:
            lines.append(f"| **扩展名** | `{js_info['extension_name']}` |")
        lines.append(
            f"| **目标节点** | {', '.join(f'`{t}`' for t in js_info['targets'])} |"
        )
        hooks_display = js_info["hooks"] or ["基础注册"]
        lines.append(f"| **实现钩子** | {', '.join(f'`{h}`' for h in hooks_display)} |")
        lines.append("")

        lines.append("### 前端功能")
        lines.append("")
        lines.append(js_info.get("summary", "提供基础节点注册。"))
        lines.append("")

    # ===== DATA FLOW =====
    lines.append("## 🏗️ 数据流")
    lines.append("")
    lines.append("```text")
    if js_info:
        lines.append(
            "用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出"
        )
        lines.append("         ↑ 参数设置/预览反馈")
    else:
        lines.append("ComfyUI 图引擎 → [后端节点执行] → 输出")
    lines.append("```")
    lines.append("")

    return "\n".join(lines)


# ============================================================
# MAIN
# ============================================================


def main():
    # Collect JS files
    js_map = {}  # node_class -> info
    for f in sorted(JS_DIR.glob("*.js")):
        if f.name in SKIP_JS:
            continue
        try:
            content = f.read_text(encoding="utf-8")
        except Exception:
            continue
        info = extract_js_info(f, content)
        if info:
            for target in info["targets"]:
                js_map[target] = info

    # Collect PY files
    py_map = {}  # node_class -> list of node dicts
    for f in sorted(NODES_DIR.glob("*.py")):
        if f.name in SKIP_PY:
            continue
        try:
            content = f.read_text(encoding="utf-8")
        except Exception:
            continue
        nodes = extract_py_nodes(f, content)
        for node in nodes:
            cls = node["class_name"]
            if cls not in py_map:
                py_map[cls] = []
            py_map[cls].append(node)

    # All unique node class names
    all_nodes = set(js_map.keys()) | set(py_map.keys())

    # Also collect module-level NODE_NAME constants
    for f in sorted(NODES_DIR.glob("*.py")):
        if f.name in SKIP_PY:
            continue
        try:
            content = f.read_text(encoding="utf-8")
        except Exception:
            continue
        # Find NODE_NAME assignments at module level (before class defs)
        mod_node_names = re.findall(r'^NODE_NAME\s*=\s*"(\w+)"', content, re.MULTILINE)
        for name in mod_node_names:
            if name not in all_nodes and name not in py_map:
                # This node has a module-level name but we might have missed its class
                pass

    generated = 0
    for class_name in sorted(all_nodes):
        cat = "general"
        if class_name in py_map and py_map[class_name]:
            cat_raw = py_map[class_name][0].get("category", "")
            cat = CATEGORY_MAP.get(cat_raw, "general")

        cat_dir = SKILL_DIR / cat
        cat_dir.mkdir(parents=True, exist_ok=True)

        doc = generate_doc(
            class_name=class_name,
            py_nodes=py_map.get(class_name, []),
            js_info=js_map.get(class_name),
        )

        out = cat_dir / f"{class_name}.md"
        out.write_text(doc, encoding="utf-8")
        generated += 1
        print(f"  ✓ {class_name} -> SKILL/{cat}/{class_name}.md")

    print(f"\nGenerated {generated} node docs in SKILL/ subdirectories.")


if __name__ == "__main__":
    main()
