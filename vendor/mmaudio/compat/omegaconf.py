import ast
import re
from pathlib import Path


class AttrDict(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name, value):
        self[name] = value


def _to_attr(value):
    if isinstance(value, dict):
        return AttrDict({key: _to_attr(item) for key, item in value.items()})
    if isinstance(value, list):
        return [_to_attr(item) for item in value]
    return value


def _strip_comment(line):
    in_single = False
    in_double = False
    for index, char in enumerate(line):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return line[:index]
    return line


def _parse_scalar(value):
    value = value.strip()
    if value == "":
        return ""
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none", "~"}:
        return None
    if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        normalized = re.sub(r"\btrue\b", "True", value, flags=re.IGNORECASE)
        normalized = re.sub(r"\bfalse\b", "False", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"\bnull\b", "None", normalized, flags=re.IGNORECASE)
        return ast.literal_eval(normalized)
    try:
        if re.match(r"^[+-]?\d+$", value):
            return int(value)
        if re.match(r"^[+-]?(\d+\.\d*|\.\d+|\d+e[+-]?\d+|\d+\.\d*e[+-]?\d+)$", value, re.IGNORECASE):
            return float(value)
    except ValueError:
        pass
    return value


def _prepare_lines(text):
    lines = []
    for raw in text.splitlines():
        stripped = _strip_comment(raw).rstrip()
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        lines.append((indent, stripped.lstrip(" ")))
    return lines


def _parse_block(lines, index, indent):
    if index >= len(lines):
        return AttrDict(), index
    if lines[index][1].startswith("- "):
        return _parse_list(lines, index, indent)
    return _parse_dict(lines, index, indent)


def _parse_list(lines, index, indent):
    items = []
    while index < len(lines):
        line_indent, content = lines[index]
        if line_indent < indent or not content.startswith("- "):
            break
        if line_indent > indent:
            nested, index = _parse_block(lines, index, line_indent)
            if items and isinstance(items[-1], list):
                items[-1].extend(nested if isinstance(nested, list) else [nested])
            else:
                items.append(nested)
            continue
        value = content[2:].strip()
        index += 1
        if value.startswith("- "):
            nested_item = [_parse_scalar(value[2:].strip())]
            while index < len(lines):
                next_indent, next_content = lines[index]
                if next_indent != indent + 2 or not next_content.startswith("- "):
                    break
                nested_item.append(_parse_scalar(next_content[2:].strip()))
                index += 1
            items.append(nested_item)
        elif value == "":
            nested, index = _parse_block(lines, index, indent + 2)
            items.append(nested)
        elif ":" in value and not value.startswith(("'", '"')):
            key, child_value = value.split(":", 1)
            item = AttrDict()
            item[key.strip()] = _parse_scalar(child_value.strip()) if child_value.strip() else AttrDict()
            items.append(item)
        else:
            items.append(_parse_scalar(value))
    return items, index


def _parse_dict(lines, index, indent):
    result = AttrDict()
    while index < len(lines):
        line_indent, content = lines[index]
        if line_indent < indent:
            break
        if line_indent > indent:
            index += 1
            continue
        if ":" not in content:
            index += 1
            continue
        key, value = content.split(":", 1)
        key = key.strip()
        value = value.strip()
        index += 1
        if value:
            result[key] = _parse_scalar(value)
        else:
            if index < len(lines) and lines[index][0] > line_indent:
                child, index = _parse_block(lines, index, lines[index][0])
                result[key] = child
            else:
                result[key] = AttrDict()
    return result, index


def _fallback_yaml_load(path):
    lines = _prepare_lines(Path(path).read_text(encoding="utf-8"))
    parsed, _ = _parse_block(lines, 0, lines[0][0] if lines else 0)
    return parsed


class OmegaConf:
    @staticmethod
    def load(path):
        try:
            import yaml

            with Path(path).open("r", encoding="utf-8") as stream:
                return _to_attr(yaml.safe_load(stream) or {})
        except Exception:
            return _fallback_yaml_load(path)
