from __future__ import annotations

import torch


class GJJ_RepeatMasks:
    CATEGORY = "GJJ/遮罩"
    FUNCTION = "duplicate_input"
    DESCRIPTION = (
        "重复遮罩批次。复刻 Video Helper Suite 的 RepeatMasks / VHS_DuplicateMasks 行为，"
        "不依赖 Video Helper Suite。"
    )
    SEARCH_ALIASES = [
        "RepeatMasks",
        "Repeat Masks",
        "VHS_DuplicateMasks",
        "duplicate masks",
        "重复遮罩",
        "遮罩复制",
        "遮罩批次",
    ]

    RETURN_TYPES = ("MASK", "INT")
    RETURN_NAMES = ("重复遮罩", "遮罩数量")
    OUTPUT_TOOLTIPS = (
        "按指定次数复制后的 MASK 批次，顺序为整批遮罩重复追加。",
        "输出遮罩批次的总数量，等于输入遮罩数量乘以重复次数。",
    )

    GJJ_HELP = {
        "title": "重复遮罩",
        "description": "把输入 MASK 批次整体复制多次并拼接，常用于让遮罩数量匹配视频帧或图片批次。",
        "usage": [
            "重复次数为 1 时输出与输入遮罩数量一致。",
            "重复次数大于 1 时，会按整批顺序追加副本，例如 A,B 重复 3 次得到 A,B,A,B,A,B。",
        ],
        "notes": [
            "该节点复刻 VHS_DuplicateMasks 的核心行为，但不依赖 ComfyUI-VideoHelperSuite。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": (
                    "MASK",
                    {
                        "display_name": "遮罩",
                        "tooltip": "要重复的 MASK 批次。输入可以是单张遮罩，也可以是多张遮罩批次。",
                    },
                ),
                "multiply_by": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1_000_000,
                        "step": 1,
                        "display_name": "重复次数",
                        "tooltip": "整批遮罩重复追加的次数。1 表示不改变数量。",
                    },
                ),
            },
        }

    def duplicate_input(self, mask: torch.Tensor, multiply_by: int):
        if not isinstance(mask, torch.Tensor):
            raise RuntimeError(f"遮罩输入类型无效：{type(mask)!r}")
        if mask.ndim == 2:
            mask = mask.unsqueeze(0)
        if mask.ndim != 3:
            raise RuntimeError(f"遮罩输入维度无效，应为 MASK 或 MASK 批次，实际为：{tuple(mask.shape)}")

        repeat_count = max(1, int(multiply_by))
        if repeat_count == 1:
            new_mask = mask
        else:
            new_mask = torch.cat([mask] * repeat_count, dim=0)
        return (new_mask, int(new_mask.size(0)))


NODE_CLASS_MAPPINGS = {
    "GJJ_RepeatMasks": GJJ_RepeatMasks,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_RepeatMasks": "🎭 重复遮罩",
}
