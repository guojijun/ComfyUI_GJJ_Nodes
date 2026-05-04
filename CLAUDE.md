# GJJ ComfyUI 自定义节点开发规范

> **⚠️ 最高优先级：所有交流、思考过程、文档、代码注释、Markdown 文件默认使用简体中文。除非用户明确要求英文，否则一律中文输出。**

本项目的所有开发遵循 `.claude/skills/` 中的技能规范。开发 GJJ 节点前必须参考这些文档。

## 核心文件

- [ComfyUI-Skills-Docs.md](.claude/skills/ComfyUI-Skills-Docs.md) — 综合技能文档（含 UI 数据格式、音频/预览节点模式、通用最佳实践）
- [comfyui-gjj-node-migration.md](.claude/skills/comfyui-gjj-node-migration.md) — GJJ 节点迁移/开发核心规则
- [comfyui-model-family-presets.md](.claude/skills/comfyui-model-family-presets.md) — 模型族预设与自动匹配规则
- [comfyui-dynamic-slots.md](.claude/skills/comfyui-dynamic-slots.md) — 动态输入/输出插槽管理
- [gjj-lora-effect-tester.md](.claude/skills/gjj-lora-effect-tester.md) — LoRA 效果测试节点模式

## 快速检查清单

开发任何 GJJ 节点时必须满足：

1. **命名规范**：显示名 `GJJ · <emoji> <中文名称>`，模块文件 `gjj_` 前缀 + snake_case
2. **全中文**：所有 `display_name`、`tooltip`、`RETURN_NAMES`、`OUTPUT_TOOLTIPS` 用中文
3. **零外部依赖**：不依赖第三方自定义节点包，小辅助函数内联
4. **前端 JS**：放在 `<GJJ>/js` 下，标签/按钮/提示均为中文
5. **动态插槽**：遵循 AnySwitch stabilize 模式
6. **模型查找**：子目录感知 + 最长公共片段匹配 + 扩展名剥离
7. **1-based 编号**：用户面编号从 1 开始，内部索引用 0-based
8. **面板宽/高**：外部连接优先、面板值次之、图片尺寸初始化
9. **自定义预览**：只发出一种预览路径，不要同时返回 `ui.images`
