# GJJ_PromptCombination

## 📋 概述

**功能**: 把基础提示词、主体列表和风格列表做排列组合或随机抽样，输出提示词列表。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_prompt_combo_tools.py` | `GJJ_PromptCombination` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PromptCombination` |
| **CATEGORY** | `GJJ/Prompt` |
| **FUNCTION** | `combine` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `base_prompt` | `STRING` | `` | ✓ |  |
| `subjects` | `STRING` | `` | ✓ |  |
| `styles` | `STRING` | `` | ✓ |  |
| `split_mode` | `["按行` | `按行` | ✓ |  |
| `combine_mode` | `["全部组合` | `全部组合` | ✓ |  |
| `delimiter` | `["逗号` | `逗号` | ✓ |  |
| `max_count` | `INT` | `64` | ✓ |  |
| `seed` | `INT` | `1` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 提示词列表 | `STRING` | |
| 提示词数量 | `INT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```