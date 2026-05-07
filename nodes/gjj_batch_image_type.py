"""GJJ 批次图像类型标识。

用于标记批量处理的图像数据，同时兼容标准 IMAGE 类型。
在节点声明时使用 "GJJ_BATCH_IMAGE,IMAGE" 格式实现双重兼容。
"""
from __future__ import annotations

GJJ_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE"
