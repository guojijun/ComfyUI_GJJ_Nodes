# GJJ_InpaintStitch

## 📋 概述

**功能**: 把 GJJ 局部重绘裁切输出的重绘图拼回原图。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_inpaint_crop.py` | `GJJ_InpaintStitch` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_InpaintStitch` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `inpaint_stitch` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `stitcher` | `STITCHER` | `-` | ✓ |  |
| `inpainted_image` | `IMAGE` | `-` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 拼回图片 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```