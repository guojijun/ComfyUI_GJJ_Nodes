from __future__ import annotations

import json

try:
    import torch
except Exception:
    torch = None


DEFAULT_SIGMAS_1 = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.881203, 0.863321, 0.841251, 0.820089, 0.655, 0.381875, 0.0]
DEFAULT_SIGMAS_2 = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0]


def _safe_parse_sigmas(raw: str) -> list[float]:
    try:
        value = json.loads(str(raw or "[]"))
        if isinstance(value, list):
            return [float(v) for v in value if isinstance(v, (int, float))]
        return []
    except Exception:
        return []


def _normalize_sigmas(value) -> list[float]:
    if value is None:
        return []
    if torch is not None and isinstance(value, torch.Tensor):
        return [float(v) for v in value.detach().cpu().flatten().tolist()]
    if isinstance(value, str):
        parsed = _safe_parse_sigmas(value)
        if parsed:
            return parsed
        try:
            return [float(x.strip()) for x in value.split(",") if x.strip()]
        except Exception:
            return []
    if isinstance(value, (list, tuple)):
        return [float(x) for x in value]
    try:
        return [float(value)]
    except Exception:
        return []


class GJJ_SigmasEditor:
    DESCRIPTION = "可视化自定义Sigmas曲线编辑器。以0到1的数字点组成图表，可增减点、改变曲线方式。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "sigmas_in": ("SIGMAS,STRING", {
                    "default": None,
                    "display_name": "Sigmas输入",
                    "tooltip": "外部输入的Sigmas数据，优先级最高",
                    "forceInput": True,
                }),
            },
            "required": {
                "sigmas_data": ("STRING", {
                    "default": json.dumps(DEFAULT_SIGMAS_1),
                    "multiline": False,
                    "socketless": True,
                    "advanced": True,
                    "display_name": "Sigmas数据",
                    "tooltip": "前端内部使用的隐藏数据。",
                }),
                "curve_mode": (["linear", "smooth", "step"], {
                    "default": "smooth",
                    "display_name": "曲线方式",
                    "tooltip": "linear: 线性插值; smooth: 平滑曲线; step: 阶梯式",
                }),
                "preset": (["默认1", "默认2", "自定义"], {
                    "default": "默认1",
                    "display_name": "预设模板",
                    "tooltip": "选择预设的Sigmas模板或使用自定义",
                }),
            },
        }

    RETURN_TYPES = ("SIGMAS", "STRING")
    RETURN_NAMES = ("Sigmas", "Sigmas JSON")
    OUTPUT_TOOLTIPS = (
        "输出的Sigmas数组，可直接用于采样器。",
        "Sigmas值的JSON字符串表示。",
    )
    FUNCTION = "process"
    CATEGORY = "GJJ/工具"

    def process(self, sigmas_in=None, sigmas_data: str = "", curve_mode: str = "smooth", preset: str = "默认1"):
        if sigmas_in is not None:
            sigmas = _normalize_sigmas(sigmas_in)
        else:
            sigmas = _safe_parse_sigmas(sigmas_data)
            if not sigmas:
                if preset == "默认2":
                    sigmas = DEFAULT_SIGMAS_2.copy()
                else:
                    sigmas = DEFAULT_SIGMAS_1.copy()

        if not sigmas:
            sigmas = [1.0, 0.0]
        if torch is None:
            raise RuntimeError("Sigmas编辑器需要 ComfyUI 的 torch 环境才能输出 SIGMAS 张量。")
        sigmas_tensor = torch.tensor(sigmas, dtype=torch.float32)

        return {
            "ui": {"sigmas": [sigmas]},
            "result": (
                sigmas_tensor,
                json.dumps(sigmas, ensure_ascii=False),
            ),
        }


NODE_CLASS_MAPPINGS = {
    "GJJ_SigmasEditor": GJJ_SigmasEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_SigmasEditor": "GJJ · 📈 Sigmas编辑器",
}
