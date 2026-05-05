NODE_NAME = "GJJ_GroupBypasser"


class GJJ_GroupBypasser:
    NAME = "GJJ_GroupBypasser"
    DISPLAY_NAME = "分组筛选路由"
    CATEGORY = "GJJ"
    FUNCTION = "noop"
    DESCRIPTION = "按分组名称关键词筛选当前工作流中的分组，便于前端面板快速定位和旁路操作。"
    SEARCH_ALIASES = ["group bypasser", "group filter", "分组", "筛选", "路由", "旁路"]
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
                        "tooltip": "输入分组名称中的关键词进行筛选；留空时显示当前工作流中的全部分组。",
                    },
                ),
                "选择模式": (
                    ["单选", "多选"],
                    {
                        "default": "单选",
                        "tooltip": "单选时分组按钮互斥，只能启用一个分组；多选时可以同时启用多个匹配分组。",
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


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GroupBypasser}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔀 分组筛选路由"}
