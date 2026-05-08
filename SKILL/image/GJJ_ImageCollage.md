# GJJ_ImageCollage

## 📋 概述

**功能**: 把多路图片或图片批次拼成横排、竖排或自动网格，适合对比图、参考图和结果展示。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_image_collage.js` |  |
| 🔧 后端 | `nodes/gjj_image_collage.py` | `GJJ_ImageCollage` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageCollage` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `collage` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `layout` | `["自动网格` | `自动网格` | ✓ |  |
| `cell_mode` | `["按最长边` | `按最长边` | ✓ |  |
| `cell_size` | `INT` | `512` | ✓ |  |
| `cell_width` | `INT` | `512` | ✓ |  |
| `cell_height` | `INT` | `512` | ✓ |  |
| `fit_mode` | `["等比留边` | `等比留边` | ✓ |  |
| `gap` | `INT` | `8` | ✓ |  |
| `background` | `STRING` | `#111820` | ✓ |  |
| `labels` | `STRING` | `` | ✓ |  |
| `font_size` | `INT` | `28` | ✓ |  |
| `label_align` | `["左对齐` | `左对齐` | ✓ |  |
| `label_color` | `STRING` | `#FFFFFF` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 拼版图像 | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.ImageCollage` |
| **目标节点** | `GJJ_ImageCollage` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```