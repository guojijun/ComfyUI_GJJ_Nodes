class GJJ_TianAlign:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "说明": ("STRING", {
                    "default": "选择两个或更多节点后按 Alt+A 打开田字格对齐面板。",
                    "multiline": True,
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "GJJ/🛠️ 工具/零依赖"
    OUTPUT_NODE = False

    def execute(self, 说明=""):
        return ()


NODE_CLASS_MAPPINGS = {
    "GJJ_TianAlign": GJJ_TianAlign,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_TianAlign": "田字格对齐 (Alt+A)",
}
