# GJJ_TextMerge

## 📋 概述

**功能**: 把多路文本按顺序直接拼接，并在节点内提供预览，方便提示词和文案整合。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_text_merge.js` |  |
| 🔧 后端 | `nodes/gjj_text_merge.py` | `GJJ_TextMerge` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_TextMerge` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `merge` |
| **OUTPUT_NODE** | ✅ True |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 文本合并结果 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.TextMerge` |
| **目标节点** | `GJJ_TextMerge` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```