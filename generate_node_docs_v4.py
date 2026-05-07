#!/usr/bin/env python3
"""
GJJ Node Documentation Generator v4
Bug fixes:
  - Module-level CATEGORY/DESCRIPTION detection
  - Nested parens in tooltips fix
  - Nested braces in default extraction fix
"""

from __future__ import annotations

import re
from pathlib import Path

BASE_DIR = Path(__file__).parent
JS_DIR = BASE_DIR / "js"
NODES_DIR = BASE_DIR / "nodes"
SKILL_DIR = BASE_DIR / "SKILL"

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
    "GJJ_ColorPicker_Example.js",
    "GJJ_ColorPicker_Integration.js",
    "GJJ_ColorPicker_README.md",
    "GJJ_HELP_BUTTON_MANAGER_README.md",
}

SKIP_PY = {
    "__init__.py",
    "analyze_official_workflows.py",
    "analyze_video_workflows.py",
    "fix_insightface_bug.py",
    "gjj_batch_watermark_remover.js",
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
# TEXT UTILS
# ============================================================


def _find_matching_paren(s: str, start: int) -> int:
    """Given s[start]=='(' , return the matching ')' index."""
    depth = 0
    i = start
    while i < len(s):
        ch = s[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(s)


def _find_matching_brace(s: str, start: int) -> int:
    """Given s[start]=='{' , return the matching '}' index."""
    depth = 0
    i = start
    while i < len(s):
        ch = s[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(s)


def _extract_default_from_config(config: str) -> str:
    """Extract default value from a config dict like {'default': 42, 'min': 1}."""
    # Find "default" key (handles both 'default' and "default")
    m = re.search(
        r"""["'](?:default|DEFAULT)["']\s*:\s*(.+?)(?:,|}\s*$)""", config, re.DOTALL
    )
    if m:
        val = m.group(1).strip()
        # Trim trailing commas
        val = val.rstrip(",").strip()
        # If it's a big dict or list, just say "(complex)"
        if len(val) > 120:
            return "(see source)"
        return val.strip("'\"").strip()
    return "-"


def _split_config_tokens(config: str) -> list[str]:
    """Split a config dict value into tokens, respecting nesting."""
    # e.g. "32, {"display_name": "test", "tooltip": "hello"}"
    # -> ["32", '{"display_name": "test", "tooltip": "hello"}']
    tokens = []
    i = 0
    s = config
    current = []
    while i < len(s):
        ch = s[i]
        if ch == "{":
            end = _find_matching_brace(s, i)
            tokens.append(s[i : end + 1])
            i = end + 1
            # skip comma
            while i < len(s) and s[i] in " ,":
                i += 1
            continue
        elif ch == "(":
            end = _find_matching_paren(s, i)
            tokens.append(s[i : end + 1])
            i = end + 1
            while i < len(s) and s[i] in " ,":
                i += 1
            continue
        elif ch == ",":
            if current:
                tokens.append("".join(current).strip())
                current = []
            i += 1
        else:
            current.append(ch)
            i += 1
    if current:
        tokens.append("".join(current).strip())
    return tokens


def _extract_string_literal(s: str) -> str | None:
    """If s is a string literal, return its content."""
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        return s[1:-1]
    if s.startswith("'") and s.endswith("'"):
        return s[1:-1]
    if s.startswith('"""'):
        # triple-quoted
        inner = s[3:]
        if inner.endswith('"""'):
            inner = inner[:-3]
        return inner.strip()
    return None


# ============================================================
# PYTHON PARSING
# ============================================================


def _extract_py_class_body(src: str, class_name: str) -> str | None:
    """Extract the body of a class definition + any preceding module-level
    constants that reference this class name (NODE_NAME, CATEGORY, DESCRIPTION)."""
    # 1. Find module-level constants that reference this class
    module_prefix = []
    node_name_pattern = re.compile(rf'NODE_NAME\s*=\s*"{re.escape(class_name)}"')
    nm_match = node_name_pattern.search(src)
    if nm_match:
        # Collect lines before the match that relate (CATEGORY, DESCRIPTION, NODE_NAME, DISPLAY_NAME)
        before = src[: nm_match.start()]
        after = src[nm_match.start() :]
        # Also grab NODE_NAME line
        node_name_line = after.split("\n")[0]
        # Find CATEGORY, DESCRIPTION, DISPLAY_NAME near NODE_NAME
        for pattern in [
            r'CATEGORY\s*=\s*"[^"]*"',
            r'DESCRIPTION\s*=\s*"""',
            r'DISPLAY_NAME\s*=\s*"[^"]*"',
        ]:
            m = re.search(pattern, before)
            if m:
                # Get full triple-quoted string if DESCRIPTION
                if '"""' in pattern:
                    start = m.start()
                    # Find closing """
                    end = src.index('"""', start + 15)
                    module_prefix.append(src[start : end + 3])
                else:
                    line_start = before.rfind("\n", 0, m.start()) + 1
                    line_end = before.find("\n", m.start())
                    if line_end == -1:
                        line_end = len(before)
                    module_prefix.append(before[line_start:line_end])

    # 2. Class body
    pattern = rf"\bclass\s+{re.escape(class_name)}\s*[:(]"
    m = re.search(pattern, src)
    if not m:
        return None

    start = m.start()
    lines = src[start:].split("\n")
    body_lines = []
    if module_prefix:
        body_lines.extend(module_prefix)

    next_indent = None
    for i, line in enumerate(lines):
        stripped = line.rstrip()
        bare = stripped.lstrip()
        if i == 0:
            body_lines.append(stripped)
            continue
        if not bare or bare.startswith("#"):
            body_lines.append(stripped)
            continue

        indent = len(stripped) - len(bare)
        if next_indent is None:
            if indent > 0:
                next_indent = indent
            else:
                continue

        if indent > 0 and indent < next_indent:
            # Method or nested class at reduced indent - class body ends
            break
        if indent == 0:
            break

        body_lines.append(stripped)

    return "\n".join(body_lines)


def extract_py_nodes(filepath: Path, content: str) -> list[dict]:
    """Extract all GJJ node class definitions from a Python file."""
    nodes = []

    class_names = re.findall(r"class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:", content)
    for class_name, _ in class_names:
        body = _extract_py_class_body(content, class_name)
        if not body:
            continue

        # Must have CATEGORY somewhere (class level or module level)
        if "CATEGORY" not in body:
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

        # Extract CATEGORY (module-level or class-level)
        m = re.search(r'CATEGORY\s*=\s*"([^"]+)"', body)
        if m:
            node["category"] = m.group(1)

        # Extract FUNCTION
        m = re.search(r'FUNCTION\s*=\s*"([^"]+)"', body)
        if m:
            node["function"] = m.group(1)

        # Extract DESCRIPTION (triple-quoted multi-line or single-line)
        # Try triple-quoted first (may span lines)
        m = re.search(r'DESCRIPTION\s*=\s*"""\s*\n(.*?)\n\s*"""', body, re.DOTALL)
        if not m:
            m = re.search(r'DESCRIPTION\s*=\s*"""(.*?)"""', body, re.DOTALL)
        if not m:
            m = re.search(r"DESCRIPTION\s*=\s*'''(.*?)'''", body, re.DOTALL)
        if not m:
            m = re.search(r'DESCRIPTION\s*=\s*"([^"]+)"', body)
        if m:
            desc = m.group(1).strip()
            # Take first line or first meaningful sentence
            lines = [l for l in desc.split("\n") if l.strip()]
            first_line = lines[0] if lines else desc[:200]
            # Remove markdown header markers from DESCRIPTION content
            first_line = first_line.replace("【", "").replace("】", ": ")
            if len(first_line) > 300:
                first_line = first_line[:300] + "..."
            node["description"] = first_line

        # Extract RETURN_TYPES
        # Use balanced-paren approach
        rt_match = re.search(r"RETURN_TYPES\s*=\s*\(", body)
        if rt_match:
            end = _find_matching_paren(body, rt_match.end() - 1)
            inner = body[rt_match.end() : end]
            node["return_types"] = [
                _extract_string_literal(t.strip()) or t.strip().strip("'\"")
                for t in inner.split(",")
                if t.strip()
            ]

        # Extract RETURN_NAMES
        rn_match = re.search(r"RETURN_NAMES\s*=\s*\(", body)
        if rn_match:
            end = _find_matching_paren(body, rn_match.end() - 1)
            inner = body[rn_match.end() : end]
            node["return_names"] = [
                _extract_string_literal(n.strip()) or n.strip().strip("'\"")
                for n in inner.split(",")
                if n.strip()
            ]

        # OUTPUT_NODE
        node["output_node"] = bool(re.search(r"OUTPUT_NODE\s*=\s*True", body))

        # Parse INPUT_TYPES
        node["inputs"] = _parse_input_types(body)

        nodes.append(node)

    return nodes


def _parse_input_types(body: str) -> list[dict]:
    """Parse INPUT_TYPES dict to extract input definitions."""
    result = []

    # Find the INPUT_TYPES method's return dict
    it_match = re.search(r"def\s+INPUT_TYPES\s*\(", body)
    if not it_match:
        return result

    # Find "required" section
    req_m = re.search(r'"required"\s*:\s*\{', body[it_match.start() :])
    if req_m:
        abs_start = it_match.start() + req_m.end() - 1  # position of '{'
        req_body_end = _find_matching_brace(body, abs_start)
        req_body = body[abs_start + 1 : req_body_end]
        result.extend(_parse_input_pairs_v4(req_body, required=True))

    # Find "optional" section
    opt_m = re.search(r'"optional"\s*:\s*\{', body[it_match.start() :])
    if opt_m:
        abs_start = it_match.start() + opt_m.end() - 1
        opt_body_end = _find_matching_brace(body, abs_start)
        opt_body = body[abs_start + 1 : opt_body_end]
        result.extend(_parse_input_pairs_v4(opt_body, required=False))

    # Check for dynamic optional (Flexible/AutoIncrement)
    if not re.search(r'"optional"\s*:\s*\{', body[it_match.start() :]):
        if re.search(r'"optional"\s*:\s*\w+\(', body[it_match.start() :]):
            result.append(
                {
                    "name": "*动态输入*",
                    "type": "Dynamic",
                    "default": "-",
                    "required": False,
                    "note": "支持动态数量输入插槽",
                }
            )

    return result


def _parse_input_pairs_v4(body: str, required: bool) -> list[dict]:
    """Parse key-value pairs from INPUT_TYPES dict body (v4 - robust version).

    Handles: "param_name": (TYPE, {"default": ..., "display_name": "foo(bar)"})
    """
    result = []

    # Find each key: value pair
    # Pattern: "key_name": followed by either a (TYPE, ...) tuple or a single value
    i = 0
    while i < len(body):
        # Skip whitespace
        while i < len(body) and body[i] in " \t\n\r,":
            i += 1
        if i >= len(body):
            break

        # Must start with a string key
        if body[i] not in "\"'":
            # Might be a comment or unexpected content
            nl = body.find("\n", i)
            i = nl + 1 if nl != -1 else len(body)
            continue

        # Extract key name
        quote = body[i]
        key_end = body.index(quote, i + 1)
        key_name = body[i + 1 : key_end]
        i = key_end + 1

        # Skip : and whitespace
        while i < len(body) and body[i] in " \t:":
            i += 1
        if i >= len(body):
            break

        # Now we expect either a (TYPE, ...config...) tuple or a simple value
        if body[i] == "(":
            # Tuple: find matching )
            tuple_end = _find_matching_paren(body, i)
            tuple_content = body[i + 1 : tuple_end]
            i = tuple_end + 1

            # Split tuple content: first token is TYPE, rest is config
            tokens = _split_config_tokens(tuple_content)
            ptype = tokens[0].strip().strip("'\"") if tokens else "?"

            # Find default from config dict (second+ tokens)
            default = "-"
            for tok in tokens[1:]:
                if tok.strip().startswith("{"):
                    d = _extract_default_from_config(tok)
                    if d != "-":
                        default = d
                        break

            result.append(
                {
                    "name": key_name,
                    "type": ptype,
                    "default": default,
                    "required": required,
                }
            )
        else:
            # Simple value like "STRING" or BOOLEAN
            # Just grab until , or }
            j = i
            while j < len(body) and body[j] not in ",}\n":
                j += 1
            val = body[i:j].strip().strip("'\"")
            result.append(
                {
                    "name": key_name,
                    "type": val,
                    "default": "-",
                    "required": required,
                }
            )
            i = j

        # Skip trailing comma/whitespace
        while i < len(body) and body[i] in " ,\n\r\t":
            i += 1

    return result


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

    # Extension name
    m = re.search(r'(?:const|let|var)\s+\w+Name\s*=\s*["\']([^"\']+)["\']', content)
    if m:
        info["extension_name"] = m.group(1)
    if not info["extension_name"]:
        m = re.search(r'name\s*:\s*["\']([^"\']+)["\']', content)
        if m:
            info["extension_name"] = m.group(1)

    # Hooks
    for hook in [
        "nodeCreated",
        "beforeRegisterNodeDef",
        "loadedGraphNode",
        "setup",
        "init",
    ]:
        if hook in content:
            info["hooks"].append(hook)

    # Summary: read the @classdesc or leading comment block
    m = re.search(r"/\*\*\s*\n\s*\*\s*@classdesc\s+(.*?)\*/", content, re.DOTALL)
    if m:
        info["summary"] = m.group(1).strip()
    else:
        # Try first JSDoc-style comment
        m = re.search(r"/\*\*\s*(.*?)\*/", content, re.DOTALL)
        if m:
            comment = m.group(1).strip()
            # Take non-tag lines
            lines = []
            for line in comment.split("\n"):
                line = line.lstrip("* \t").strip()
                if line and not line.startswith("@"):
                    lines.append(line)
            info["summary"] = " ".join(lines)[:300]

    return info


# ============================================================
# MARKDOWN GENERATION
# ============================================================


def generate_md(node: dict, js_info: dict | None, py_file: str) -> str:
    """Generate markdown documentation for one node."""
    name = node["class_name"]
    lines = []

    lines.append(f"# {name}")
    lines.append("")
    lines.append("## 📋 概述")
    lines.append("")

    desc = node.get("description", "")
    if desc:
        # Clean up description: replace 【 and 】
        desc = desc.replace("【", "**").replace("】", "**")
        lines.append(f"**功能**: {desc}")
    else:
        lines.append(f"**功能**: 节点 `{name}`")

    lines.append("")
    lines.append("## 📁 文件映射")
    lines.append("")
    lines.append("| 层级 | 文件 | 说明 |")
    lines.append("|------|------|------|")

    js_file = js_info["file"] if js_info else "-"
    js_desc = js_info.get("summary", "前端交互逻辑") if js_info else "无前端文件"
    lines.append(f"| 🎨 前端 | `js/{js_file}` | {js_desc} |")
    lines.append(f"| 🔧 后端 | `nodes/{py_file}` | `{name}` 后端执行逻辑 |")

    lines.append("")
    lines.append("## 🔧 后端节点")
    lines.append("")
    lines.append("### 基础信息")
    lines.append("")
    lines.append("| 属性 | 值 |")
    lines.append("|------|-----|")
    lines.append(f"| **类名** | `{name}` |")
    cat = node.get("category", "") or "GJJ"
    lines.append(f"| **CATEGORY** | `{cat}` |")
    lines.append(f"| **FUNCTION** | `{node.get('function', '-')}` |")

    if node.get("output_node"):
        lines.append(f"| **OUTPUT_NODE** | ✅ True |")

    # Inputs
    inputs = node.get("inputs", [])
    if inputs:
        lines.append("")
        lines.append("### 输入参数")
        lines.append("")
        lines.append("| 参数名 | 类型 | 默认值 | 必填 | 说明 |")
        lines.append("|--------|------|--------|------|------|")
        for inp in inputs:
            req = "✓" if inp.get("required") else ""
            dft = inp.get("default", "-")
            note = inp.get("note", "")
            lines.append(
                f"| `{inp['name']}` | `{inp['type']}` | `{dft}` | {req} | {note} |"
            )

    # Outputs
    ret_types = node.get("return_types", [])
    ret_names = node.get("return_names", [])
    if ret_types:
        lines.append("")
        lines.append("### 输出")
        lines.append("")
        lines.append("| 输出名 | 类型 | 说明 |")
        lines.append("|--------|------|------|")
        for i, rt in enumerate(ret_types):
            rn = ret_names[i] if i < len(ret_names) else "-"
            lines.append(f"| {rn} | `{rt}` | |")

    # Frontend
    if js_info and js_info.get("targets"):
        lines.append("")
        lines.append("## 🎨 前端扩展")
        lines.append("")
        lines.append("### 注册信息")
        lines.append("")
        lines.append("| 属性 | 值 |")
        lines.append("|------|-----|")
        ext_name = js_info.get("extension_name", "-")
        lines.append(f"| **扩展名** | `{ext_name}` |")
        targets = js_info.get("targets", [])
        lines.append(f"| **目标节点** | `{', '.join(targets)}` |")
        hooks = js_info.get("hooks", [])
        lines.append(f"| **实现钩子** | `{', '.join(hooks) if hooks else '-'}` |")

        if js_info.get("summary"):
            lines.append("")
            lines.append("### 前端功能")
            lines.append("")
            lines.append(js_info["summary"])

    # Data flow
    lines.append("")
    lines.append("## 🏗️ 数据流")
    lines.append("")
    lines.append("```text")
    lines.append("用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出")
    lines.append("         ↑ 参数设置/预览反馈")
    lines.append("```")

    return "\n".join(lines)


def get_output_subdir(category: str) -> str:
    """Map GJJ category to SKILL subdirectory."""
    return CATEGORY_MAP.get(category, "general")


# ============================================================
# MAIN
# ============================================================


def main():
    print("=" * 60)
    print("GJJ Node Documentation Generator v4")
    print("=" * 60)

    # Collect all PY files
    py_files = sorted(NODES_DIR.glob("*.py"))
    print(f"\n📂 Found {len(py_files)} Python files in nodes/")

    # Collect all JS files
    js_files = sorted(JS_DIR.glob("*.js"))
    print(f"📂 Found {len(js_files)} JavaScript files in js/")

    # Build JS lookup by target node name
    js_map = {}  # target_node_name -> js_info
    for js_path in js_files:
        if js_path.name in SKIP_JS:
            continue
        content = js_path.read_text(encoding="utf-8", errors="ignore")
        info = extract_js_info(js_path, content)
        if info and info["targets"]:
            for target in info["targets"]:
                if target not in js_map:
                    js_map[target] = info

    # Ensure SKILL subdirs exist
    for subdir in set(CATEGORY_MAP.values()):
        (SKILL_DIR / subdir).mkdir(parents=True, exist_ok=True)

    count = 0
    for py_path in py_files:
        if py_path.name in SKIP_PY:
            continue

        content = py_path.read_text(encoding="utf-8", errors="ignore")
        nodes = extract_py_nodes(py_path, content)

        if not nodes:
            continue

        for node in nodes:
            class_name = node["class_name"]
            js_info = js_map.get(class_name)

            md_content = generate_md(node, js_info, py_path.name)

            cat = get_output_subdir(node.get("category", ""))
            out_path = SKILL_DIR / cat / f"{class_name}.md"
            out_path.write_text(md_content, encoding="utf-8")
            count += 1

            js_flag = "✓" if js_info else "✗"
            print(f"  {js_flag} {class_name} -> {cat}/{class_name}.md")

    print(f"\n✅ Generated {count} node docs in SKILL/ subdirectories.")


if __name__ == "__main__":
    main()
