# GJJ_EmbeddingPrompt

## 📋 概述

**功能**: 生成 embedding 提示词片段，并可附加权重。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_prompt_combo_tools.py` | `GJJ_EmbeddingPrompt` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_EmbeddingPrompt` |
| **CATEGORY** | `GJJ/Prompt` |
| **FUNCTION** | `make` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `embedding` | `names` | `names[0]` | ✓ |  |
| `manual_name` | `STRING` | `` | ✓ |  |
| `weight` | `FLOAT` | `1.0` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| Embedding提示词 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```