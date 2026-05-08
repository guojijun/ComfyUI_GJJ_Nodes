---
name: GJJ Node Naming Convention
description: All GJJ frontend nodes must follow GJJ · emoji + Chinese display name format
type: feedback
---

GJJ 前台节点的 `NODE_DISPLAY_NAME_MAPPINGS` 必须使用 `"emoji 中文名称"` 格式（不含 `GJJ ·` 前缀，`__init__.py` 的 `_normalize_display_name` 会自动加上）。

**Why:** ComfyUI Skills 综合文档第3条明确约定：前台显示名格式 `GJJ · <emoji> <中文名称>`（如 `GJJ · 👀 任意对象预览器`、`GJJ · ✂️ 图片分割器`）。所有面向用户的文字（tooltip、label、占位文本、错误提示）都必须是中文。

**How to apply:** 创建新 GJJ 节点时：
- `NODE_DISPLAY_NAME_MAPPINGS` 写为 `"emoji 中文名称"`，不要加 `GJJ ·` 前缀
- 所有 `tooltip`、`display_name`、`RETURN_NAMES`、`OUTPUT_TOOLTIPS` 用中文
- JS 前端所有按钮/标签/空状态/提示文字用中文
- 后台/引用节点用 `guojijun_` 前缀，不受此规则限制
