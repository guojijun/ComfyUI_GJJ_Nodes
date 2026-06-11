from __future__ import annotations

from typing import Any

try:
    import nodes as comfy_nodes
    from comfy_execution.graph import ExecutionBlocker
    from comfy_execution.graph_utils import GraphBuilder, is_link
except Exception:  # pragma: no cover - lets the package load far enough to show import errors in ComfyUI.
    comfy_nodes = None
    ExecutionBlocker = None
    GraphBuilder = None
    is_link = None


MAX_FLOW_NUM = 20
ANY_TYPE = "*"


class AlwaysEqualProxy(str):
    def __eq__(self, _: object) -> bool:
        return True

    def __ne__(self, _: object) -> bool:
        return False


class TautologyStr(str):
    def __ne__(self, _: object) -> bool:
        return False


class ByPassTypeTuple(tuple):
    def __getitem__(self, index):
        if isinstance(index, int) and index > 0:
            index = 0
        item = super().__getitem__(index)
        if isinstance(item, str):
            return TautologyStr(item)
        return item


any_type = AlwaysEqualProxy(ANY_TYPE)


def _send_status(unique_id: Any, text: str, progress: float | None = None, **extra: Any) -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer

        payload = {
            "node": str(unique_id),
            "text": str(text or ""),
            "progress": None if progress is None else max(0.0, min(1.0, float(progress))),
        }
        payload.update(extra)
        PromptServer.instance.send_sync("gjj_for_loop_status", payload)
    except Exception:
        pass


def _require_graph_builder() -> None:
    if GraphBuilder is None or is_link is None:
        raise RuntimeError("当前 ComfyUI 缺少 GraphBuilder，无法执行 GJJ 循环节点。")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _candidate_node_ids(dynprompt: Any, node_id: Any) -> list[Any]:
    ids: list[Any] = []
    if node_id is not None:
        ids.append(node_id)
    try:
        display_id = dynprompt.get_display_node_id(node_id)
        if display_id not in ids:
            ids.append(display_id)
    except Exception:
        pass
    return ids


def _read_start_total(dynprompt: Any, open_node_id: Any, fallback: int = 1) -> Any:
    if dynprompt is None:
        return fallback
    for candidate_id in _candidate_node_ids(dynprompt, open_node_id):
        try:
            node = dynprompt.get_node(candidate_id)
        except Exception:
            continue
        class_type = node.get("class_type")
        inputs = node.get("inputs", {})
        if class_type == "GJJ_ForLoopStart":
            return inputs.get("total", fallback)
        if class_type == "GJJ_ForLoopWhileStart":
            return inputs.get("condition", fallback)
    return fallback


def _total_status_text(total: Any, fallback: int = 1) -> str:
    if is_link is not None and is_link(total):
        return "外部输入"
    return str(max(1, _safe_int(total, fallback)))


class GJJ_ForLoopWhileStart:
    CATEGORY = "guojijun/内部引用/循环"
    DEPRECATED = True
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "condition": ("BOOLEAN", {"default": True, "display_name": "是否继续", "tooltip": "内部循环条件。"}),
            },
            "optional": {},
        }
        for i in range(MAX_FLOW_NUM):
            inputs["optional"][f"initial_value{i}"] = (
                any_type,
                {"display_name": f"初始值 {i}", "tooltip": "内部循环携带值。"},
            )
        return inputs

    RETURN_TYPES = ByPassTypeTuple(tuple(["FLOW_CONTROL"] + [any_type] * MAX_FLOW_NUM))
    RETURN_NAMES = ByPassTypeTuple(tuple(["循环控制"] + [f"值{i}" for i in range(MAX_FLOW_NUM)]))
    OUTPUT_TOOLTIPS = tuple(["内部循环控制。"] + ["内部循环携带值。"] * MAX_FLOW_NUM)
    FUNCTION = "while_loop_open"

    def while_loop_open(self, condition: bool, **kwargs):
        values = []
        for i in range(MAX_FLOW_NUM):
            value = kwargs.get(f"initial_value{i}", None)
            values.append(value if condition else ExecutionBlocker(None))
        return tuple(["stub"] + values)


class GJJ_ForLoopWhileEnd:
    CATEGORY = "guojijun/内部引用/循环"
    DEPRECATED = True
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "flow": ("FLOW_CONTROL", {"rawLink": True, "display_name": "循环控制", "tooltip": "来自内部循环开始节点。"}),
                "condition": ("BOOLEAN", {"display_name": "是否继续", "tooltip": "为真时递归展开下一轮循环。"}),
            },
            "optional": {},
            "hidden": {
                "dynprompt": "DYNPROMPT",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }
        for i in range(MAX_FLOW_NUM):
            inputs["optional"][f"initial_value{i}"] = (
                any_type,
                {"display_name": f"循环值 {i}", "tooltip": "传递到下一轮循环的值。"},
            )
        return inputs

    RETURN_TYPES = ByPassTypeTuple(tuple([any_type] * MAX_FLOW_NUM))
    RETURN_NAMES = ByPassTypeTuple(tuple([f"值{i}" for i in range(MAX_FLOW_NUM)]))
    OUTPUT_TOOLTIPS = tuple(["循环结束时输出最终值；继续时作为下一轮值。"] * MAX_FLOW_NUM)
    FUNCTION = "while_loop_close"

    def explore_dependencies(self, node_id: Any, dynprompt: Any, upstream: dict, parent_ids: list) -> None:
        node_info = dynprompt.get_node(node_id)
        if "inputs" not in node_info:
            return
        for value in node_info["inputs"].values():
            if is_link(value):
                parent_id = value[0]
                display_id = dynprompt.get_display_node_id(parent_id)
                display_node = dynprompt.get_node(display_id)
                if display_node.get("class_type") not in {"GJJ_ForLoopEnd", "GJJ_ForLoopWhileEnd"}:
                    parent_ids.append(display_id)
                if parent_id not in upstream:
                    upstream[parent_id] = []
                    self.explore_dependencies(parent_id, dynprompt, upstream, parent_ids)
                upstream[parent_id].append(node_id)

    def explore_output_nodes(self, dynprompt: Any, upstream: dict, output_nodes: dict, parent_ids: list) -> None:
        for parent_id in upstream:
            display_id = dynprompt.get_display_node_id(parent_id)
            for output_id, linked_input in output_nodes.items():
                linked_node_id = linked_input[0]
                if linked_node_id in parent_ids and display_id == linked_node_id and output_id not in upstream[parent_id]:
                    if "." in str(parent_id):
                        parts = str(parent_id).split(".")
                        parts[-1] = str(output_id)
                        upstream[parent_id].append(".".join(parts))
                    else:
                        upstream[parent_id].append(output_id)

    def collect_contained(self, node_id: Any, upstream: dict, contained: dict) -> None:
        if node_id not in upstream:
            return
        for child_id in upstream[node_id]:
            if child_id not in contained:
                contained[child_id] = True
                self.collect_contained(child_id, upstream, contained)

    def while_loop_close(self, flow, condition, dynprompt=None, unique_id=None, **kwargs):
        _require_graph_builder()
        if not condition:
            return tuple(kwargs.get(f"initial_value{i}", None) for i in range(MAX_FLOW_NUM))

        upstream: dict[Any, list] = {}
        parent_ids: list[Any] = []
        self.explore_dependencies(unique_id, dynprompt, upstream, parent_ids)
        parent_ids = list(set(parent_ids))

        output_nodes = {}
        prompts = dynprompt.get_original_prompt()
        mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) if comfy_nodes is not None else {}
        for node_id, node in prompts.items():
            if "inputs" not in node:
                continue
            class_def = mappings.get(node.get("class_type"))
            if getattr(class_def, "OUTPUT_NODE", False):
                for value in node["inputs"].values():
                    if is_link(value):
                        output_nodes[node_id] = value

        graph = GraphBuilder()
        self.explore_output_nodes(dynprompt, upstream, output_nodes, parent_ids)
        contained = {}
        open_node = flow[0]
        self.collect_contained(open_node, upstream, contained)
        contained[unique_id] = True
        contained[open_node] = True

        for node_id in contained:
            original_node = dynprompt.get_node(node_id)
            node = graph.node(original_node["class_type"], "Recurse" if node_id == unique_id else node_id)
            node.set_override_display_id(node_id)
        for node_id in contained:
            original_node = dynprompt.get_node(node_id)
            node = graph.lookup_node("Recurse" if node_id == unique_id else node_id)
            for key, value in original_node["inputs"].items():
                if is_link(value) and value[0] in contained:
                    parent = graph.lookup_node(value[0])
                    node.set_input(key, parent.out(value[1]))
                else:
                    node.set_input(key, value)

        new_open = graph.lookup_node(open_node)
        for i in range(MAX_FLOW_NUM):
            key = f"initial_value{i}"
            new_open.set_input(key, kwargs.get(key, None))
        my_clone = graph.lookup_node("Recurse")
        return {
            "result": tuple(my_clone.out(i) for i in range(MAX_FLOW_NUM)),
            "expand": graph.finalize(),
        }


class GJJ_ForLoopIntAdd:
    CATEGORY = "guojijun/内部引用/循环"
    DEPRECATED = True
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "a": ("INT", {"default": 0, "display_name": "数值 A", "tooltip": "内部整数输入。"}),
                "b": ("INT", {"default": 1, "display_name": "数值 B", "tooltip": "内部整数输入。"}),
            },
            "optional": {
                "status_start_id": ("STRING", {"default": "", "display_name": "开始节点ID", "tooltip": "内部状态回写。"}),
                "status_end_id": ("STRING", {"default": "", "display_name": "结束节点ID", "tooltip": "内部状态回写。"}),
                "status_total": ("STRING", {"default": "", "display_name": "总轮次", "tooltip": "内部状态回写。"}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("结果",)
    OUTPUT_TOOLTIPS = ("两个整数相加的结果。",)
    FUNCTION = "add"

    def add(self, a: int, b: int, status_start_id: str = "", status_end_id: str = "", status_total: str = ""):
        result = _safe_int(a) + _safe_int(b)
        total_value = _safe_int(status_total, 0)
        if total_value > 0:
            next_round = result + 1
            progress = min(1.0, max(0.0, next_round / total_value))
            if result < total_value:
                _send_status(status_start_id, f"运行中：第 {next_round} / {total_value} 轮", progress, total=total_value, index=result, state="running")
                _send_status(status_end_id, f"回传中：第 {result} 轮完成，准备第 {next_round} / {total_value} 轮", progress, total=total_value, index=result, state="checking")
            else:
                _send_status(status_start_id, f"已完成：共 {total_value} 轮", 1.0, total=total_value, index=total_value - 1, state="done")
                _send_status(status_end_id, f"循环结束：共 {total_value} 轮", 1.0, total=total_value, index=total_value - 1, state="done")
        elif status_start_id or status_end_id:
            display_index = result
            total_text = str(status_total or "外部输入")
            _send_status(status_start_id, f"运行中：当前序号 {display_index}", None, total=total_text, index=display_index, state="running")
            _send_status(status_end_id, f"回传中：当前序号 {display_index}，准备判断下一轮", None, total=total_text, index=display_index, state="checking")
        return (result,)


class GJJ_ForLoopIntLess:
    CATEGORY = "guojijun/内部引用/循环"
    DEPRECATED = True
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "a": ("INT", {"default": 0, "display_name": "数值 A", "tooltip": "内部整数输入。"}),
                "b": ("INT", {"default": 1, "display_name": "数值 B", "tooltip": "内部整数输入。"}),
            }
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("是否小于",)
    OUTPUT_TOOLTIPS = ("A 小于 B 时为真。",)
    FUNCTION = "less"

    def less(self, a: int, b: int):
        return (_safe_int(a) < _safe_int(b),)


class GJJ_ForLoopStart:
    CATEGORY = "GJJ/逻辑/循环"
    DESCRIPTION = "For 循环开始节点。默认只显示一组初始值/值输出；值 1 连线后自动扩展值 2。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "total": ("INT", {"default": 1, "min": 1, "max": 100000, "step": 1, "display_name": "总循环次数", "tooltip": "循环执行的总次数，从 1 开始计数。"}),
            },
            "optional": {
                f"initial_value{i}": (any_type, {"display_name": f"初始值 {i}", "tooltip": f"第 {i} 路循环携带值；连接值 {i} 后会显示下一路。"})
                for i in range(1, MAX_FLOW_NUM)
            },
            "hidden": {
                "initial_value0": (any_type,),
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ByPassTypeTuple(tuple(["FLOW_CONTROL", "INT"] + [any_type] * (MAX_FLOW_NUM - 1)))
    RETURN_NAMES = ByPassTypeTuple(tuple(["循环控制", "当前序号"] + [f"值 {i}" for i in range(1, MAX_FLOW_NUM)]))
    OUTPUT_TOOLTIPS = tuple(["连接到 GJJ_ForLoopEnd 的循环控制口。", "当前循环序号，从 0 开始。"] + ["当前轮携带值。"] * (MAX_FLOW_NUM - 1))
    FUNCTION = "for_loop_start"

    def for_loop_start(self, total: int, prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        _require_graph_builder()
        total = max(1, _safe_int(total, 1))
        index = _safe_int(kwargs.get("initial_value0", 0), 0)
        progress = min(1.0, max(0.0, (index + 1) / total))
        _send_status(unique_id, f"运行中：第 {index + 1} / {total} 轮", progress, total=total, index=index, state="running")

        initial_values = {f"initial_value{i}": kwargs.get(f"initial_value{i}", None) for i in range(1, MAX_FLOW_NUM)}
        graph = GraphBuilder()
        graph.node("GJJ_ForLoopWhileStart", condition=total, initial_value0=index, **initial_values)
        outputs = [kwargs.get(f"initial_value{i}", None) for i in range(1, MAX_FLOW_NUM)]
        return {
            "result": tuple(["stub", index] + outputs),
            "expand": graph.finalize(),
        }


class GJJ_ForLoopEnd:
    CATEGORY = "GJJ/逻辑/循环"
    DESCRIPTION = "For 循环结束节点。接收本轮更新后的 value，并决定是否展开下一轮。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flow": ("FLOW_CONTROL", {"rawLink": True, "display_name": "循环控制", "tooltip": "连接 GJJ_ForLoopStart 的循环控制输出。"}),
            },
            "optional": {
                f"initial_value{i}": (any_type, {"rawLink": True, "display_name": f"值 {i}", "tooltip": f"第 {i} 路传回下一轮的值；连接值 {i} 后会显示下一路。"})
                for i in range(1, MAX_FLOW_NUM)
            },
            "hidden": {
                "dynprompt": "DYNPROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ByPassTypeTuple(tuple([any_type] * (MAX_FLOW_NUM - 1)))
    RETURN_NAMES = ByPassTypeTuple(tuple([f"值 {i}" for i in range(1, MAX_FLOW_NUM)]))
    OUTPUT_TOOLTIPS = tuple(["循环完成后输出最终值。"] * (MAX_FLOW_NUM - 1))
    FUNCTION = "for_loop_end"

    def for_loop_end(self, flow, dynprompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        _require_graph_builder()
        graph = GraphBuilder()
        while_open = flow[0]
        total = _read_start_total(dynprompt, while_open, 1)
        total_text = _total_status_text(total, 1)
        try:
            start_node_id = dynprompt.get_display_node_id(while_open)
        except Exception:
            start_node_id = while_open

        next_index = graph.node(
            "GJJ_ForLoopIntAdd",
            a=[while_open, 1],
            b=1,
            status_start_id=str(start_node_id or ""),
            status_end_id=str(unique_id or ""),
            status_total=str(total if not (is_link is not None and is_link(total)) else ""),
        )
        condition = graph.node("GJJ_ForLoopIntLess", a=next_index.out(0), b=total)
        input_values = {f"initial_value{i}": kwargs.get(f"initial_value{i}", None) for i in range(1, MAX_FLOW_NUM)}
        while_close = graph.node(
            "GJJ_ForLoopWhileEnd",
            flow=flow,
            condition=condition.out(0),
            initial_value0=next_index.out(0),
            **input_values,
        )

        _send_status(unique_id, f"回传中：准备判断下一轮，总循环 {total_text} 轮", None, total=total_text, state="checking")
        return {
            "result": tuple(while_close.out(i) for i in range(1, MAX_FLOW_NUM)),
            "expand": graph.finalize(),
        }


NODE_CLASS_MAPPINGS = {
    "GJJ_ForLoopStart": GJJ_ForLoopStart,
    "GJJ_ForLoopEnd": GJJ_ForLoopEnd,
    "GJJ_ForLoopWhileStart": GJJ_ForLoopWhileStart,
    "GJJ_ForLoopWhileEnd": GJJ_ForLoopWhileEnd,
    "GJJ_ForLoopIntAdd": GJJ_ForLoopIntAdd,
    "GJJ_ForLoopIntLess": GJJ_ForLoopIntLess,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ForLoopStart": "🔁 For循环开始",
    "GJJ_ForLoopEnd": "🔚 For循环结束",
    "GJJ_ForLoopWhileStart": "循环开始（内部引用）",
    "GJJ_ForLoopWhileEnd": "循环结束（内部引用）",
    "GJJ_ForLoopIntAdd": "整数加法（内部引用）",
    "GJJ_ForLoopIntLess": "整数小于（内部引用）",
}
