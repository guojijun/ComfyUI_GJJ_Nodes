NODE_NAME = "GJJ_NodeRouter"


class GJJ_NodeRouter:
    NAME = "GJJ_NodeRouter"
    DISPLAY_NAME = "节点筛选路由"
    CATEGORY = "GJJ"
    FUNCTION = "noop"
    DESCRIPTION = "按节点名称关键词筛选当前工作流中的节点，便于前端面板快速定位和启用/禁用操作。"
    SEARCH_ALIASES = ["node router", "node filter", "节点", "筛选", "路由", "启用", "禁用"]
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "过滤关键词": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "输入节点名称中的关键词进行筛选；留空时显示当前工作流中的全部节点。",
                    },
                ),
                "选择模式": (
                    ["单选", "多选"],
                    {
                        "default": "单选",
                        "tooltip": "单选时节点按钮互斥，只能启用一个节点；多选时可以同时启用多个匹配节点。",
                    },
                ),
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

    def noop(self, **kwargs):
        return ()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_NodeRouter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔀 节点筛选路由"}
