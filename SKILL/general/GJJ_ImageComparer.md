# GJJ_ImageComparer

## 📋 概述

**功能**: 对比两路图片，使用简单滑动分割线查看差异。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_image_compare.js` |  |
| 🔧 后端 | `nodes/gjj_image_compare.py` | `GJJ_ImageComparer` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageComparer` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `compare_images` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image_a` | `IMAGE` | `-` |  |  |
| `image_b` | `IMAGE` | `-` |  |  |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.ImageCompare` |
| **目标节点** | `GJJ_ImageComparer` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```