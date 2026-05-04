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
            "required": {
                "filter_keyword": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "过滤关键词",
                        "multiline": False,
                        "tooltip": "输入分组名称中的关键词进行筛选；留空时显示当前工作流中的全部分组。",
                    },
                ),
                "selection_mode": (
                    ["单选", "多选"],
                    {
                        "default": "单选",
                        "display_name": "选择模式",
                        "tooltip": "单选时分组按钮互斥，只能启用一个分组；多选时可以同时启用多个匹配分组。",
                    },
                ),
            }
        }

    def noop(self, filter_keyword, selection_mode="单选"):
        return ()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GroupBypasser}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔀 分组筛选路由"}
