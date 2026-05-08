# GJJ_ColorBalance

## 📋 概述

**功能**: 调整图像的阴影、中间调和高光的色彩平衡。与 ComfyUI 系统 Color Balance 节点功能一致，支持批量处理。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_color_balance.js` | GJJ 色彩平衡节点前端实现 功能： 1. Canvas 彩色滑块（重写 widget.draw） 2. 节点内预览图（直接绘制在 Canvas 上） |
| 🔧 后端 | `nodes/gjj_color_balance.py` | `GJJ_ColorBalance` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ColorBalance` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `apply` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `MIXED_BATCH_IMAGE_TYPE` | `-` | ✓ |  |
| `shadows_red` | `FLOAT` | `0.0` | ✓ |  |
| `shadows_green` | `FLOAT` | `0.0` | ✓ |  |
| `shadows_blue` | `FLOAT` | `0.0` | ✓ |  |
| `midtones_red` | `FLOAT` | `0.0` | ✓ |  |
| `midtones_green` | `FLOAT` | `0.0` | ✓ |  |
| `midtones_blue` | `FLOAT` | `0.0` | ✓ |  |
| `highlights_red` | `FLOAT` | `0.0` | ✓ |  |
| `highlights_green` | `FLOAT` | `0.0` | ✓ |  |
| `highlights_blue` | `FLOAT` | `0.0` | ✓ |  |
| `preserve_luminosity` | `BOOLEAN` | `True` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| IMAGE | `MIXED_BATCH_IMAGE_TYPE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.ColorBalance.CanvasUI` |
| **目标节点** | `GJJ_ColorBalance` |
| **实现钩子** | `beforeRegisterNodeDef, init` |

### 前端功能

GJJ 色彩平衡节点前端实现 功能： 1. Canvas 彩色滑块（重写 widget.draw） 2. 节点内预览图（直接绘制在 Canvas 上）

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```