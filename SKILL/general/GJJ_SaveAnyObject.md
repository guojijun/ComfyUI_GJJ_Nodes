# GJJ_SaveAnyObject

## 📋 概述

**功能**: 动态接收多个任意输入，根据对象类型自动保存为视频、图片、文本、JSON、Tensor、音频或对象摘要。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_save_any_object.js` |  |
| 🔧 后端 | `nodes/gjj_save_any_object.py` | `GJJ_SaveAnyObject` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SaveAnyObject` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `save` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `filename_prefix` | `STRING` | `GJJ/任意对象` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 保存路径JSON | `STRING` | |
| 首个保存路径 | `STRING` | |
| 保存文件数 | `INT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.SaveAnyObject` |
| **目标节点** | `GJJ_SaveAnyObject` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```