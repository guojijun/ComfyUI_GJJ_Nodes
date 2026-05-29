from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_WanVideoTorchCompileSettings"

BACKEND_LABEL_TO_VALUE = {
    "inductor（Inductor：通用编译后端，需要 Triton）": "inductor",
    "cudagraphs（CUDA Graphs：低开销后端，不需要 Triton）": "cudagraphs",
    "inductor": "inductor",
    "cudagraphs": "cudagraphs",
}

MODE_LABEL_TO_VALUE = {
    "default（默认：平衡兼容性与速度）": "default",
    "max-autotune（最大自动调优：更激进，首次编译更久）": "max-autotune",
    "max-autotune-no-cudagraphs（最大调优但禁用 CUDA Graphs）": "max-autotune-no-cudagraphs",
    "reduce-overhead（降低运行开销：适合重复形状）": "reduce-overhead",
    "default": "default",
    "max-autotune": "max-autotune",
    "max-autotune-no-cudagraphs": "max-autotune-no-cudagraphs",
    "reduce-overhead": "reduce-overhead",
}

BACKEND_CHOICES = list(BACKEND_LABEL_TO_VALUE.keys())[:2]
MODE_CHOICES = list(MODE_LABEL_TO_VALUE.keys())[:4]


def _choice_value(value: str, mapping: dict[str, str], default: str) -> str:
    text = str(value or "").strip()
    if text in mapping:
        return mapping[text]
    for raw in set(mapping.values()):
        if text == raw:
            return raw
    return default


class GJJ_WanVideoTorchCompileSettings:
    CATEGORY = "GJJ/视频模型/WanVideo"
    FUNCTION = "set_args"
    DESCRIPTION = (
        "GJJ 零依赖复刻 WanVideoTorchCompileSettings：生成 WanVideo 模型加载器可读取的 "
        "torch.compile 参数字典。节点只输出配置，不调用 torch.compile。"
    )
    SEARCH_ALIASES = [
        "WanVideoTorchCompileSettings",
        "WanVideo Torch Compile Settings",
        "WANCOMPILEARGS",
        "torch compile",
        "torch.compile",
        "编译设置",
        "WanVideo编译",
    ]

    RETURN_TYPES = ("WANCOMPILEARGS",)
    RETURN_NAMES = ("Torch编译参数",)
    OUTPUT_TOOLTIPS = ("WanVideo 模型加载器可读取的 torch.compile 参数字典；字段名与原版 WanVideoWrapper 保持一致。",)

    GJJ_HELP = {
        "title": "WanVideo Torch 编译设置",
        "description": "生成 WanVideoWrapper 同款 WANCOMPILEARGS 配置，可连接到支持 compile_args 的 GJJ/WanVideo 模型加载节点。",
        "usage": [
            "下拉菜单使用中英对照显示；输出字典仍按原版节点输出英文原值。",
            "backend、fullgraph、mode、dynamic 等字段按原版节点原样输出。",
            "本节点只生成参数，不加载模型，也不执行 torch.compile。",
            "真正编译发生在下游 WanVideo 模型加载器接收到该参数后。",
        ],
        "notes": [
            "字段名保持为 backend、fullgraph、mode、dynamic、dynamo_cache_size_limit、dynamo_recompile_limit、compile_transformer_blocks_only、force_parameter_static_shapes、allow_unmerged_lora_compile。",
            "不依赖 ComfyUI-WanVideoWrapper 插件本体，也不新增第三方 pip 依赖。",
            "如果下游实际启用 torch.compile，Triton 与 PyTorch 版本要求仍由下游运行环境决定。",
        ],
        "⚠️ Triton 依赖要求": [
            "当 backend 选择 'inductor' 时，PyTorch 需要 Triton 编译器支持。",
            "错误提示: 'Cannot find a working triton installation'",
            "解决方法:",
            "1. 安装 Triton: pip install triton",
            "2. 或切换 backend 为 'cudagraphs' (不需要 Triton)",
            "3. 或不连接本节点以禁用 torch.compile",
        ],
        "📦 依赖安装命令": [
            "# 安装 Triton (推荐)",
            "pip install triton",
            "",
            "# Windows 用户注意",
            "# 如果标准安装失败，可尝试预编译版本:",
            "# pip install https://github.com/woct0rdho/triton-windows/releases/download/v3.5.0-windows.post21/triton-3.5.0.dev20241205-cp310-none-win_amd64.whl",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "backend": (
                    BACKEND_CHOICES,
                    {
                        "default": BACKEND_CHOICES[0],
                        "display_name": "编译后端",
                        "tooltip": "torch.compile 使用的 backend。菜单显示中英对照，输出仍会转为英文原值：inductor 或 cudagraphs。",
                    },
                ),
                "fullgraph": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "完整图模式",
                        "tooltip": "对应 torch.compile 的 fullgraph。开启后要求整段图可被编译，失败概率也更高。",
                    },
                ),
                "mode": (
                    MODE_CHOICES,
                    {
                        "default": MODE_CHOICES[0],
                        "display_name": "编译模式",
                        "tooltip": "对应 torch.compile 的 mode 参数。菜单显示中英对照，输出仍会转为原版英文值。",
                    },
                ),
                "dynamic": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "动态形状",
                        "tooltip": "对应 torch.compile 的 dynamic。开启后允许动态形状图，但可能影响速度或兼容性。",
                    },
                ),
                "dynamo_cache_size_limit": (
                    "INT",
                    {
                        "default": 64,
                        "min": 0,
                        "max": 1024,
                        "step": 1,
                        "display_name": "Dynamo缓存上限",
                        "tooltip": "对应 torch._dynamo.config.cache_size_limit。",
                    },
                ),
                "compile_transformer_blocks_only": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "仅编译Transformer块",
                        "tooltip": "只编译 transformer blocks。通常已足够，并能减少编译时间和报错概率。",
                    },
                ),
            },
            "optional": {
                "dynamo_recompile_limit": (
                    "INT",
                    {
                        "default": 128,
                        "min": 0,
                        "max": 1024,
                        "step": 1,
                        "display_name": "Dynamo重编译上限",
                        "tooltip": "对应 torch._dynamo.config.recompile_limit。",
                    },
                ),
                "force_parameter_static_shapes": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "强制参数静态形状",
                        "tooltip": "对应 torch._dynamo.config.force_parameter_static_shapes。默认值按原版面板保持为关闭。",
                    },
                ),
                "allow_unmerged_lora_compile": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "允许未合并LoRA编译",
                        "tooltip": "允许把未合并 LoRA 的应用过程纳入 torch.compile，可能避免 graph break，但部分动态 LoRA 可能出问题。",
                    },
                ),
            },
        }

    def set_args(
        self,
        backend: str,
        fullgraph: bool,
        mode: str,
        dynamic: bool,
        dynamo_cache_size_limit: int,
        compile_transformer_blocks_only: bool,
        dynamo_recompile_limit: int = 128,
        force_parameter_static_shapes: bool = True,
        allow_unmerged_lora_compile: bool = False,
    ) -> tuple[dict[str, Any]]:
        backend_value = _choice_value(backend, BACKEND_LABEL_TO_VALUE, "inductor")
        mode_value = _choice_value(mode, MODE_LABEL_TO_VALUE, "default")
        compile_args = {
            "backend": backend_value,
            "fullgraph": fullgraph,
            "mode": mode_value,
            "dynamic": dynamic,
            "dynamo_cache_size_limit": dynamo_cache_size_limit,
            "dynamo_recompile_limit": dynamo_recompile_limit,
            "compile_transformer_blocks_only": compile_transformer_blocks_only,
            "force_parameter_static_shapes": force_parameter_static_shapes,
            "allow_unmerged_lora_compile": allow_unmerged_lora_compile,
        }

        return (compile_args,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoTorchCompileSettings,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "⚙️ WanVideo编译设置",
}
