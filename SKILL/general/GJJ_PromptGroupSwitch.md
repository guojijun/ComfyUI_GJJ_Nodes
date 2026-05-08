# GJJ_PromptGroupSwitch

## 📋 概述

**功能**: 在同一个工作流里维护多组提示词文本，并按序号切换输出当前选中的那一组。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_prompt_group_switch.py` | `GJJ_PromptGroupSwitch` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PromptGroupSwitch` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `func` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `group_id` | `STRING` | `group_1` | ✓ |  |
| `select` | `INT` | `1` | ✓ |  |
| `prompt_1` | `STRING` | `` |  |  |
| `prompt_2` | `STRING` | `` |  |  |
| `prompt_3` | `STRING` | `` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 切换提示结果 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```