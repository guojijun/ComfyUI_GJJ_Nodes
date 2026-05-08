# GJJ_TextJoinWithDelimiter

## 📋 概述

**功能**: 把文本列表或多路文本按指定分隔符合并，适合把批量提示词片段汇总成一段。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_prompt_combo_tools.py` | `GJJ_TextJoinWithDelimiter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_TextJoinWithDelimiter` |
| **CATEGORY** | `GJJ/Prompt` |
| **FUNCTION** | `join` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `delimiter` | `["逗号` | `逗号` | ✓ |  |
| `skip_empty` | `BOOLEAN` | `True` | ✓ |  |
| `text_1` | `STRING` | `-` |  |  |
| `text_2` | `STRING` | `-` |  |  |
| `text_3` | `STRING` | `-` |  |  |
| `text_4` | `STRING` | `-` |  |  |
| `text_5` | `STRING` | `-` |  |  |
| `text_6` | `STRING` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 合并文本 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```