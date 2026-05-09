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
