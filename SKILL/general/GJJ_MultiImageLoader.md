# GJJ_MultiImageLoader

## 📋 概述

**功能**: 一次选择多张 input 目录里的图片，在节点中网格预览并按选择数量同步扩展图片输出接口。可作为主图图片、输入图像、原图来源的默认加载节点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_multi_image_loader.js` |  |
| 🔧 后端 | `nodes/gjj_multi_image_loader.py` | `GJJ_MultiImageLoader` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_MultiImageLoader` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `load_images` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `selected_images` | `STRING` | `[]` | ✓ |  |
| `sequence_range` | `STRING` | `` |  |  |
| `input_images` | `INPUT_IMAGE_TYPES` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 批量图片队列 | `GJJ_BATCH_IMAGE` | |
| - | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.MultiImageLoader` |
| **目标节点** | `GJJ_MultiImageLoader` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```