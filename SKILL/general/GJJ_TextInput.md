# GJJ_TextInput

## 📋 概述

**功能**: 提供一个可手填或透传外部输入的文本节点，适合作为工作流里的文本源头；前端支持 Markdown 预览模式。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_text_input.js` |  |
| 🔧 后端 | `nodes/gjj_text_input.py` | `GJJ_TextInput` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_TextInput` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `output_text` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `text` | `STRING` | `` | ✓ |  |
| `text_in` | `STRING` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 文本输入结果 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.TextInput` |
| **目标节点** | `GJJ_TextInput` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```