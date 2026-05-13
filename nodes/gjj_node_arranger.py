"""
GJJ Node Arranger - ComfyUI 节点自动排列工具
支持智能排列、水平/垂直/网格排列、多种拓扑排序方式
"""

NODE_NAME = "GJJ_NodeArranger"


class GJJ_NodeArranger:
    NAME = "GJJ_NodeArranger"
    DISPLAY_NAME = "节点排列器"
    CATEGORY = "GJJ/工作流辅助"
    FUNCTION = "arrange_nodes"
    DESCRIPTION = "自动排列和优化 ComfyUI 工作流中的节点布局，支持多种拓扑排序模式。实际排列逻辑在前端 JavaScript 中执行。"
    SEARCH_ALIASES = [
        "node arranger",
        "node layout",
        "节点排列",
        "自动布局",
        "整理节点",
        "arrange",
        "layout",
        "topological",
        "拓扑排序",
    ]
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "排列模式": ([
                    "auto",
                    "topo_main_path",
                    "topo_output_anchor",
                    "topo_compact",
                    "topo_branch",
                    "topo_original_y",
                    "horizontal",
                    "vertical",
                    "grid",
                ], {
                    "default": "auto",
                    "tooltip": (
                        "排列模式："
                        "auto-智能排列；"
                        "topo_main_path-拓扑主链路；"
                        "topo_output_anchor-拓扑输出锚定；"
                        "topo_compact-拓扑紧凑层级；"
                        "topo_branch-拓扑分支优先；"
                        "topo_original_y-拓扑保持上下；"
                        "horizontal-水平排列；"
                        "vertical-垂直排列；"
                        "grid-网格排列"
                    ),
                }),
                "间距": ("INT", {
                    "default": 26,
                    "min": 0,
                    "max": 240,
                    "step": 8,
                    "tooltip": "节点基础间距。前端支持 Alt+←/→ 调整列宽，Alt+↑/↓ 调整行高。",
                }),
                "迭代次数": ("INT", {
                    "default": 10,
                    "min": 1,
                    "max": 50,
                    "step": 1,
                    "tooltip": "智能排列时使用的迭代次数",
                }),
                "松弛力度": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.1,
                    "tooltip": "智能排列时的松弛力度",
                }),
                "碰撞检测": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "启用碰撞检测，避免节点重叠",
                }),
                "保持连接": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "尽量保持连接关系清晰",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        import hashlib

        m = hashlib.sha256()
        for key in sorted(kwargs.keys()):
            m.update(str(key).encode("utf-8"))
            m.update(str(kwargs[key]).encode("utf-8"))
        return m.hexdigest()

    def arrange_nodes(
        self,
        排列模式="auto",
        间距=100,
        迭代次数=10,
        松弛力度=0.5,
        碰撞检测=True,
        保持连接=True,
        **kwargs,
    ):
        print(
            f"[GJJ_NodeArranger] 节点排列请求: "
            f"排列模式={排列模式}, 间距={间距}, 迭代次数={迭代次数}, "
            f"松弛力度={松弛力度}, 碰撞检测={碰撞检测}, 保持连接={保持连接}"
        )
        print("[GJJ_NodeArranger] 实际排列由前端 JS 执行。")
        print("[GJJ_NodeArranger] 可用入口：")
        print("  - 右键画布 -> 📐 GJJ 节点排列")
        print("  - 顶部工具栏 -> 📐 排列节点 / 🔢 拓扑排序 / 拓扑模式下拉框")
        print("  - 智能范围：无选择或全选时作用全部；部分选择时只作用所选")
        print("  - 快捷键: Ctrl+Shift+A 循环排列模式")
        print("  - 快捷键: Ctrl+Alt+A 全部折叠 / 全部打开")
        print("  - 快捷键: Alt+←/→ 调整列宽，Alt+↑/↓ 调整行高")
        print("  - 快捷键: Ctrl+Shift+T 拓扑主链路")
        print("  - 快捷键: Ctrl+Shift+H/V/G 水平/垂直/网格")
        return ()


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_NodeArranger,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 📐 节点排列器",
}
