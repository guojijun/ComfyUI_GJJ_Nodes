from __future__ import annotations

import folder_paths


NODE_NAME = "GJJ_WanVideoVACEModelSelect"


def _scan_diffusion_models(keyword="vace"):
    """扫描 diffusion_models 目录，按关键词过滤并返回模型列表。
    
    Args:
        keyword: 过滤关键词，默认 "vace"
    
    Returns:
        (model_list, default_model) 元组
    """
    all_models = []
    try:
        all_models = list(folder_paths.get_filename_list("diffusion_models"))
    except Exception:
        pass
    
    gguf_models = []
    try:
        gguf_models = list(folder_paths.get_filename_list("unet_gguf"))
    except Exception:
        pass
    
    all_models = gguf_models + all_models
    
    if not all_models:
        return ["[未找到模型]"], "[未找到模型]"
    
    keyword_lower = keyword.lower()
    matched = [
        name for name in all_models
        if keyword_lower in name.lower()
    ]
    
    if matched:
        return matched, matched[0]
    
    return all_models, all_models[0]


class GJJ_WanVideoVACEModelSelect:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "getvacepath"
    DESCRIPTION = "选择 VACE 模型，用于不包含 VACE 的主模型。从 diffusion_models 目录加载。"
    SEARCH_ALIASES = [
        "WanVideo VACE Model Select",
        "VACE 模型选择",
        "WanVideo 额外模型",
    ]
    RETURN_TYPES = ("VACEPATH",)
    RETURN_NAMES = ("额外模型",)
    OUTPUT_TOOLTIPS = ("VACE 模型路径列表",)

    @classmethod
    def INPUT_TYPES(cls):
        diffusion_models, default_model = _scan_diffusion_models("vace")
        
        return {
            "required": {
                "vace_model": (
                    diffusion_models,
                    {
                        "default": default_model,
                        "display_name": "VACE 模型",
                        "tooltip": "从 diffusion_models 和 unet_gguf 目录加载 VACE 模型，默认优先显示包含 vace 的模型。",
                    },
                ),
            },
        }

    def getvacepath(self, vace_model):
        vace_model_path = folder_paths.get_full_path_or_raise("diffusion_models", vace_model)
        vace_model_list = [{"path": vace_model_path}]
        return (vace_model_list,)


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoVACEModelSelect": GJJ_WanVideoVACEModelSelect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoVACEModelSelect": "🧩 WanVideo VACE 模型选择",
}
