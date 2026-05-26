import folder_paths


NODE_NAME = "GJJ_WanVideoPromptExtenderSelect"


def _system_prompt_labels():
    try:
        from ..vendor.wanvideo_wrapper.qwen.system_prompt import SYSTEM_PROMPT_MAP

        labels = [item.get("label", "") for item in SYSTEM_PROMPT_MAP]
        return [label for label in labels if label]
    except Exception:
        return ["T2V_A14B_ZH"]


def _resolve_system_prompt(label, custom_system_prompt):
    if custom_system_prompt:
        return custom_system_prompt
    try:
        from ..vendor.wanvideo_wrapper.qwen.system_prompt import SYSTEM_PROMPT_MAP

        return next((item.get("prompt", "") for item in SYSTEM_PROMPT_MAP if item.get("label") == label), "")
    except Exception:
        return ""


class GJJ_WanVideoPromptExtenderSelect:
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "生成 WanVideo 提示词扩展参数，可连接到 GJJ · WanVideo 文本编码（缓存版）的提示词扩展参数输入。"
    RETURN_TYPES = ("WANVIDEOPROMPTEXTENDER_ARGS",)
    RETURN_NAMES = ("提示词扩展参数",)
    FUNCTION = "set"
    OUTPUT_TOOLTIPS = ("WanVideo 文本编码缓存版可读取的 Qwen 提示词扩展参数。",)

    GJJ_HELP = {
        "title": "WanVideo 提示词扩展参数",
        "description": "选择 Qwen LLM 权重和系统提示词，供文本编码缓存版在编码前扩展正向提示词。",
        "tips": [
            "该节点本身不加载 Qwen，只保存参数；执行文本编码时才会加载模型。",
            "Qwen 权重按 WanVideoWrapper 原版习惯放在 models/text_encoders。",
            "连接到 GJJ · 📝 WanVideo 文本编码（缓存版）的“提示词扩展参数”输入。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        text_encoders = folder_paths.get_filename_list("text_encoders")
        if not text_encoders:
            text_encoders = ["请先放入 Qwen text_encoder 权重"]
        return {
            "required": {
                "model": (
                    text_encoders,
                    {
                        "display_name": "Qwen模型",
                        "tooltip": "Qwen 提示词扩展模型权重，读取 models/text_encoders。",
                    },
                ),
                "max_new_tokens": (
                    "INT",
                    {
                        "default": 512,
                        "min": 1,
                        "max": 2048,
                        "step": 1,
                        "display_name": "最大新Token",
                        "tooltip": "Qwen 扩展提示词时最多生成的新 token 数。",
                    },
                ),
                "system_prompt": (
                    _system_prompt_labels(),
                    {
                        "display_name": "系统提示词",
                        "tooltip": "WanVideoWrapper 内置的提示词扩展系统模板。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "display_name": "随机种子",
                        "tooltip": "Qwen 采样随机种子。",
                    },
                ),
            },
            "optional": {
                "custom_system_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "自定义系统提示词",
                        "tooltip": "非空时覆盖上方系统提示词模板。",
                    },
                ),
            },
        }

    def set(self, model, system_prompt, max_new_tokens, seed=0, custom_system_prompt=""):
        sys_prompt = _resolve_system_prompt(system_prompt, custom_system_prompt)
        return (
            {
                "model": model,
                "system_prompt": sys_prompt,
                "max_new_tokens": int(max_new_tokens),
                "device": "gpu",
                "force_offload": True,
                "seed": int(seed),
            },
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoPromptExtenderSelect}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🪄 WanVideo提示词扩展参数"}
