# GJJ_SizeMath

## 📋 概述

**功能**: 获取一张或多张图片尺寸，执行长边缩放、短边缩放、旋转和比例预设计算，并输出尺寸统计结果。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_size_math.js` |  |
| 🔧 后端 | `nodes/gjj_size_math.py` | `GJJ_SizeMath` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SizeMath` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `calculate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `aspect_ratio` | `ASPECT_RATIO_OPTIONS` | `1:1` | ✓ |  |
| `width` | `INT` | `1024` | ✓ |  |
| `height` | `INT` | `1024` | ✓ |  |
| `size_mode` | `SIZE_MODE_OPTIONS` | `直接指定` | ✓ |  |
| `edge_length` | `INT` | `1024` | ✓ |  |
| `rotation_mode` | `ROTATION_MODE_OPTIONS` | `不旋转` | ✓ |  |
| `align_multiple` | `INT` | `DEFAULT_ALIGN_MULTIPLE` | ✓ |  |
| `output_size_mode` | `OUTPUT_SIZE_MODE_OPTIONS` | `当前尺寸` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 输出目标宽度 | `INT` | |
| 输出目标高度 | `INT` | |
| 最大面积图片 | `IMAGE` | |
| 最小面积图片 | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.SizeMath` |
| **目标节点** | `GJJ_SizeMath` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```