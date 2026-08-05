from __future__ import annotations

from .gjj_spectrum_h3_runtime import (
    SpectrumH3Config,
    SpectrumH3Runtime,
    install_h3_wrapper,
    install_sampler_wrappers,
    require_native_minimax_h3,
)


NODE_NAME = "GJJ_SpectrumApplyMiniMaxH3"
NODE_DISPLAY_NAME = "GJJ · ⚡ Spectrum 应用 MiniMax H3"


class GJJ_SpectrumApplyMiniMaxH3:
    """为 ComfyUI 原生 MiniMax H3 模型应用 Spectrum 频谱预测加速。"""

    DESCRIPTION = (
        "通过历史特征的切比雪夫岭回归预测部分 MiniMax H3 Transformer 步骤，"
        "减少实际模型计算。仅支持 ComfyUI 原生 MiniMaxH3Model。"
    )
    CATEGORY = "GJJ/采样与加速"
    FUNCTION = "apply"
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("已应用 Spectrum 的模型",)
    OUTPUT_TOOLTIPS = ("可直接连接采样器的 MiniMax H3 MODEL；输入模型本身不会被修改。",)
    GJJ_HELP = {
        "说明": DESCRIPTION,
        "兼容采样器": ["Euler", "RES Multistep", "RES Multistep CFG++"],
        "建议": "先使用默认参数；需要更激进加速时逐步提高预测窗口或频谱混合权重。",
        "注意": "历史数量必须不少于多项式阶数加一；非原生 MiniMax H3 模型会被拒绝。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "MiniMax H3 模型",
                        "tooltip": "必须是 ComfyUI 原生 MiniMax H3 模型；节点会克隆后再应用 Spectrum。",
                    },
                ),
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "启用 Spectrum",
                        "tooltip": "关闭时原样输出输入模型，不安装任何包装。",
                    },
                ),
                "blend_weight": (
                    "FLOAT",
                    {
                        "default": 0.50,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "频谱混合权重",
                        "tooltip": "频谱预测与线性外推的混合比例。0 为纯线性，1 为纯频谱；默认 0.5。",
                    },
                ),
                "degree": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 16,
                        "step": 1,
                        "display_name": "多项式阶数",
                        "tooltip": "切比雪夫回归阶数。阶数越高拟合能力越强，但至少需要“阶数 + 1”条历史记录。",
                    },
                ),
                "ridge_lambda": (
                    "FLOAT",
                    {
                        "default": 0.10,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "岭回归强度",
                        "tooltip": "稳定频谱拟合的正则化强度；数值越大越保守。默认 0.10。",
                    },
                ),
                "window_size": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 1.0,
                        "max": 16.0,
                        "step": 0.05,
                        "display_name": "预测窗口",
                        "tooltip": "允许连续使用预测步骤的基础窗口大小。较大数值速度更快，但可能降低稳定性。",
                    },
                ),
                "flex_window": (
                    "FLOAT",
                    {
                        "default": 0.75,
                        "min": 0.0,
                        "max": 8.0,
                        "step": 0.05,
                        "display_name": "自适应窗口增量",
                        "tooltip": "预测稳定时逐步增加窗口的幅度；设为 0 可关闭窗口增长。",
                    },
                ),
                "warmup_steps": (
                    "INT",
                    {
                        "default": 5,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "display_name": "预热实算步数",
                        "tooltip": "采样开始时强制完整计算的步数，用于建立可靠历史。",
                    },
                ),
                "tail_actual_steps": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "display_name": "末尾实算步数",
                        "tooltip": "采样结束前强制完整计算的步数，有助于稳定最终细节。",
                    },
                ),
                "max_history": (
                    "INT",
                    {
                        "default": 8,
                        "min": 2,
                        "max": 64,
                        "step": 1,
                        "display_name": "最大历史数量",
                        "tooltip": "保存用于回归的实际特征数量；必须不小于“多项式阶数 + 1”。",
                    },
                ),
                "debug": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "调试日志",
                        "tooltip": "在控制台输出实算步、预测步、回退次数、内存占用和耗时统计。",
                    },
                ),
            },
            "optional": {
                "history_storage": (
                    ["系统内存（RAM）", "显存（VRAM）"],
                    {
                        "default": "系统内存（RAM）",
                        "display_name": "历史存储位置",
                        "tooltip": "系统内存更节省显存；显存可减少传输但会持续占用 VRAM。",
                    },
                ),
            },
        }

    def apply(
        self,
        model,
        enabled,
        blend_weight,
        degree,
        ridge_lambda,
        window_size,
        flex_window,
        warmup_steps,
        tail_actual_steps,
        max_history,
        debug,
        history_storage="系统内存（RAM）",
    ):
        if not enabled:
            return (model,)

        try:
            require_native_minimax_h3(model)
        except TypeError as exc:
            raise TypeError(
                "Spectrum MiniMax H3 仅支持 ComfyUI 原生 MiniMaxH3Model；"
                "当前输入不是兼容模型。"
            ) from exc
        if int(max_history) < int(degree) + 1:
            raise ValueError("最大历史数量必须不少于“多项式阶数 + 1”。")
        storage = "vram" if str(history_storage) in {"vram", "显存（VRAM）"} else "system_ram"
        config = SpectrumH3Config(
            enabled=bool(enabled),
            blend_weight=float(blend_weight),
            degree=int(degree),
            ridge_lambda=float(ridge_lambda),
            window_size=float(window_size),
            flex_window=float(flex_window),
            warmup_steps=int(warmup_steps),
            tail_actual_steps=int(tail_actual_steps),
            max_history=int(max_history),
            history_storage=storage,
            debug=bool(debug),
        ).validate()

        patched = model.clone()
        try:
            require_native_minimax_h3(patched)
        except TypeError as exc:
            raise TypeError("模型克隆后不再符合原生 MiniMax H3 接口，无法应用 Spectrum。") from exc
        runtime = SpectrumH3Runtime(config)
        install_sampler_wrappers(patched, runtime)
        install_h3_wrapper(patched)
        return (patched,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SpectrumApplyMiniMaxH3}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}


__all__ = [
    "GJJ_SpectrumApplyMiniMaxH3",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
