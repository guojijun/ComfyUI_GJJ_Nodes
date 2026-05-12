"""
GJJ Node Arranger - ComfyUI 节点自动排列工具
基于 Blender NodeRelax 插件的算法，适配 ComfyUI 环境
零依赖实现，支持智能节点布局优化
"""

NODE_NAME = "GJJ_NodeArranger"


class GJJ_NodeArranger:
    NAME = "GJJ_NodeArranger"
    DISPLAY_NAME = "节点排列器"
    CATEGORY = "GJJ/工作流辅助"
    FUNCTION = "arrange_nodes"
    DESCRIPTION = "自动排列和优化 ComfyUI 工作流中的节点布局，支持多种排列模式和参数调整。也可通过右键菜单、顶部工具栏或快捷键使用。"
    SEARCH_ALIASES = ["node arranger", "node layout", "节点排列", "自动布局", "整理节点", "arrange", "layout"]
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "排列模式": (["auto", "horizontal", "vertical", "grid"], {
                    "default": "auto",
                    "tooltip": "排列模式：auto-智能排列, horizontal-水平排列, vertical-垂直排列, grid-网格排列"
                }),
                "间距": ("INT", {
                    "default": 100,
                    "min": 20,
                    "max": 500,
                    "step": 10,
                    "tooltip": "节点间距（像素）"
                }),
                "迭代次数": ("INT", {
                    "default": 10,
                    "min": 1,
                    "max": 50,
                    "step": 1,
                    "tooltip": "迭代次数，影响排列精细度"
                }),
                "松弛力度": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.1,
                    "tooltip": "松弛力度，控制节点移动的幅度"
                }),
                "碰撞检测": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "启用碰撞检测，避免节点重叠"
                }),
                "保持连接": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "尊重连接关系，保持数据流向清晰"
                }),
            },
            "optional": {
                "仅选中节点": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "仅排列选中的节点"
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
            m.update(str(kwargs[key]).encode())
        return m.hexdigest()

    def arrange_nodes(self, 排列模式="auto", 间距=100, 迭代次数=10,
                     松弛力度=0.5, 碰撞检测=True,
                     保持连接=True, 仅选中节点=False, **kwargs):
        """
        节点排列主函数

        这个函数本身不执行实际的排列操作，因为 ComfyUI 的节点排列需要在前端 JavaScript 中完成。
        这个节点的作用是触发前端的排列功能，并传递参数。

        Args:
            mode: 排列模式
            spacing: 节点间距
            iterations: 迭代次数
            relax_power: 松弛力度
            collision_avoidance: 是否启用碰撞检测
            respect_connections: 是否尊重连接关系
            selected_only: 是否仅排列选中节点

        Returns:
            空元组（这是一个输出节点）
        """
        # 这个节点主要用于触发前端功能
        # 实际的排列逻辑在 JavaScript 中实现
        print(f"[GJJ_NodeArranger] 节点排列请求: 排列模式={排列模式}, 间距={间距}, 迭代次数={迭代次数}")
        print("[GJJ_NodeArranger] 提示：您也可以使用以下方式快速排列节点：")
        print("  - 右键画布 -> 📐 GJJ 节点排列")
        print("  - 顶部工具栏 -> 📐 排列节点 按钮")
        print("  - 快捷键: Ctrl+Shift+A (自动), H (水平), V (垂直), G (网格)")

        return ()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_NodeArranger}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📐 节点排列器"}
